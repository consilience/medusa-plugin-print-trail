import path from "node:path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { StepResponse } from "@medusajs/framework/workflows-sdk"
import {
  calculateShippingOptionsPricesWorkflow,
  createPromotionsWorkflow,
  createRegionsWorkflow,
  createTaxRegionsWorkflow,
  updateProductVariantsWorkflow,
  updateStoresWorkflow,
} from "@medusajs/medusa/core-flows"
import { printTrailCalculatedShippingContext } from "../../src/shipping-options"
import { useMock } from "./harness"
import { adminHeaders, type Headers } from "./helpers/admin"
import { seedStore, type Seed } from "./helpers/seed"
import { ADDRESS } from "./helpers/store"

jest.setTimeout(120_000)

useMock()

// The store's hook handler, as a store would register it, switched on only
// by the tests that want it: a hook takes one handler for the process, and
// /calculate is also tested without it.
let pricingContextHelper = false
calculateShippingOptionsPricesWorkflow.hooks.setCalculatedShippingPricingContext(async (input, context) =>
  pricingContextHelper ? printTrailCalculatedShippingContext(input, context) : new StepResponse({})
)

// Per-country bands and free delivery over a cart total in a rate card,
// priced through Medusa's own store routes and edited through the plugin's
// admin route against Medusa's real merge of a shipping option's data.
const DEFAULT_BANDS = [
  { max_weight: 1000, prices: { gbp: 12 } },
  { max_weight: 2000, prices: { gbp: 20 } },
]
const FRANCE = [
  { max_weight: 500, prices: { gbp: 8.25 } },
  { max_weight: 2000, prices: { gbp: 10 } },
]
const GERMANY = [{ max_weight: 2000, prices: { gbp: 9 } }]

medusaIntegrationTestRunner({
  cwd: path.join(__dirname, "app"),
  testSuite: ({ api, getContainer }) => {
    let seed: Seed
    let admin: Headers
    let europeRegionId: string
    let optionId: string
    const store = () => ({ headers: { "x-publishable-api-key": seed.publishableKey } })
    const allow = { validateStatus: () => true }

    // A cart of the 400 g Print Trail book, shipping to `country`.
    const cartTo = async (country: string, quantity = 1) => {
      const { data } = await api.post(
        "/store/carts",
        {
          region_id: europeRegionId,
          email: "ada@harness.test",
          items: [{ variant_id: seed.variants.pt, quantity }],
          shipping_address: { ...ADDRESS, country_code: country },
        },
        store()
      )
      return data.cart.id as string
    }
    const calculate = async (option: string, cartId: string) => {
      const res = await api.post(`/store/shipping-options/${option}/calculate`, { cart_id: cartId, data: {} }, { ...store(), ...allow })
      return res.status === 200 ? (res.data.shipping_option.amount as number) : res
    }
    const price = async (country: string, quantity = 1) => calculate(optionId, await cartTo(country, quantity))
    const saveCard = (card: Record<string, unknown>) =>
      api.post(`/admin/print-trail/shipping-options/${optionId}`, { rate_card: card }, admin)
    const viewCard = async () => {
      const { data } = await api.get("/admin/print-trail/shipping-options", admin)
      return data.shipping_options.find((o: any) => o.id === optionId).rate_card
    }

    beforeAll(async () => {
      const container = getContainer()
      seed = await seedStore(container)
      admin = await adminHeaders(container)

      // A GBP region and a service zone for France, Germany and Iceland, on
      // the seeded fulfilment set.
      const {
        result: [region],
      } = await createRegionsWorkflow(container).run({
        input: { regions: [{ name: "Europe", currency_code: "gbp", countries: ["fr", "de", "is"], payment_providers: ["pp_system_default"] }] },
      })
      europeRegionId = region.id
      const query = container.resolve(ContainerRegistrationKeys.QUERY)
      const { data: zones } = await query.graph({ entity: "service_zone", fields: ["id", "fulfillment_set_id"] })
      const [zone] = await container.resolve(Modules.FULFILLMENT).createServiceZones([
        {
          name: "Europe",
          fulfillment_set_id: zones[0].fulfillment_set_id as string,
          geo_zones: ["fr", "de", "is"].map((country_code) => ({ type: "country" as const, country_code })),
        },
      ])

      const { data } = await api.post(
        "/admin/print-trail/shipping-options",
        {
          name: "International Tracked",
          service_zone_id: zone.id,
          shipping_profile_id: seed.ptProfileId,
          rate_card: { method: "tracked", currency_code: "gbp", bands: DEFAULT_BANDS, countries: { FR: FRANCE } },
        },
        admin
      )
      optionId = data.shipping_option.id
      expect(data.shipping_option.rate_card.countries).toEqual({ fr: FRANCE })

      // The same default bands, free over £40, for the free-delivery tests.
      const { data: free } = await api.post(
        "/admin/print-trail/shipping-options",
        {
          name: "Standard Free Over",
          service_zone_id: zone.id,
          shipping_profile_id: seed.ptProfileId,
          rate_card: { method: "standard", currency_code: "gbp", bands: DEFAULT_BANDS, free_over: { GBP: 40 } },
        },
        admin
      )
      freeOptionId = free.shipping_option.id
      expect(free.shipping_option.rate_card.free_over).toEqual({ gbp: 40 })

      // £5 off the cart's items and half off them, applied by code.
      await createPromotionsWorkflow(container).run({
        input: {
          promotionsData: [
            {
              code: "FIVEOFF",
              type: "standard",
              status: "active",
              application_method: { type: "fixed", target_type: "order", allocation: "across", value: 5, currency_code: "gbp" },
            },
            {
              code: "HALFOFF",
              type: "standard",
              status: "active",
              application_method: { type: "percentage", target_type: "order", allocation: "across", value: 50 },
            },
          ],
        },
      })

      // Iceland taxes items at 50%, on tax-exclusive prices: a £10 book
      // counts £15 in item_total.
      await createTaxRegionsWorkflow(container).run({
        input: [{ country_code: "is", provider_id: "tp_system", default_tax_rate: { rate: 50, name: "VAT", code: "VAT" } }],
      })

      // A euro region (Italy) with its own zone and a card priced in both
      // currencies, free over £40 or €50; the books get a euro price.
      const { data: stores } = await query.graph({ entity: "store", fields: ["id"] })
      await updateStoresWorkflow(container).run({
        input: {
          selector: { id: stores[0].id },
          update: { supported_currencies: [{ currency_code: "gbp", is_default: true }, { currency_code: "eur" }] },
        },
      })
      const {
        result: [euro],
      } = await createRegionsWorkflow(container).run({
        input: { regions: [{ name: "Italy", currency_code: "eur", countries: ["it"], payment_providers: ["pp_system_default"] }] },
      })
      euroRegionId = euro.id
      const [italy] = await container.resolve(Modules.FULFILLMENT).createServiceZones([
        { name: "Italy", fulfillment_set_id: zones[0].fulfillment_set_id as string, geo_zones: [{ type: "country" as const, country_code: "it" }] },
      ])
      await updateProductVariantsWorkflow(container).run({
        input: {
          product_variants: [seed.variants.pt, seed.variants.pt2].map((id) => ({
            id,
            prices: [
              { currency_code: "gbp", amount: 10 },
              { currency_code: "eur", amount: 10 },
            ],
          })),
        },
      })
      const { data: eur } = await api.post(
        "/admin/print-trail/shipping-options",
        {
          name: "Standard Free Over EUR",
          service_zone_id: italy.id,
          shipping_profile_id: seed.ptProfileId,
          rate_card: {
            method: "standard",
            currency_code: "gbp",
            bands: [{ max_weight: 2000, prices: { gbp: 20, eur: 15 } }],
            free_over: { gbp: 40, eur: 50 },
          },
        },
        admin
      )
      euroOptionId = eur.shipping_option.id
    })

    // The seeded book is £10 and 400 g.
    let freeOptionId: string
    let euroRegionId: string
    let euroOptionId: string
    const methodsOf = async (cartId: string) => {
      const { data } = await api.get(`/store/carts/${cartId}`, store())
      return { item_total: data.cart.item_total as number, amounts: data.cart.shipping_methods.map((m: any) => m.amount) }
    }
    const addMethod = async (cartId: string, option: string) => {
      const res = await api.post(`/store/carts/${cartId}/shipping-methods`, { option_id: option, data: {} }, { ...store(), ...allow })
      return res.status === 200 ? res.data.cart.shipping_methods.map((m: any) => m.amount) : res
    }
    const withPromotion = async (cartId: string) => {
      const { data } = await api.post(`/store/carts/${cartId}/promotions`, { promo_codes: ["FIVEOFF"] }, store())
      return data.cart.item_total as number
    }

    it("makes an option free when the cart's item total reaches its threshold", async () => {
      // £30, 1200 g: the 2 kg band.
      expect(await addMethod(await cartTo("de", 3), freeOptionId)).toEqual([20])
      // £40 exactly, 1600 g.
      expect(await addMethod(await cartTo("de", 4), freeOptionId)).toEqual([0])
      // £50.
      expect(await addMethod(await cartTo("de", 5), freeOptionId)).toEqual([0])
      // The store's option list (which never prices a calculated option)
      // gives a storefront the threshold, to compare with the cart's
      // item_total.
      const cartId = await cartTo("de", 3)
      const { data } = await api.get(`/store/shipping-options?cart_id=${cartId}`, store())
      expect(data.shipping_options.find((o: any) => o.id === freeOptionId).data.free_over).toEqual({ gbp: 40 })
      const { data: cart } = await api.get(`/store/carts/${cartId}`, store())
      expect(cart.cart.item_total).toBe(30)
    })

    it("compares the item total after a discount", async () => {
      const cartId = await cartTo("de", 4)
      expect(await withPromotion(cartId)).toBe(35)
      expect(await addMethod(cartId, freeOptionId)).toEqual([20])
      // £45 less £5 reaches it.
      const more = await cartTo("de", 4)
      await api.post(`/store/carts/${more}/line-items`, { variant_id: seed.variants.pt2, quantity: 1 }, store())
      expect(await withPromotion(more)).toBe(45)
      expect(await addMethod(more, freeOptionId)).toEqual([0])
      // Medusa's promotion route doesn't reprice the chosen shipping method
      // (updateCartPromotionsWorkflow runs no shipping refresh): a code
      // applied after the free method was chosen leaves it free until the
      // next cart update reprices it.
      const chosen = await cartTo("de", 4)
      expect(await addMethod(chosen, freeOptionId)).toEqual([0])
      expect(await withPromotion(chosen)).toBe(35)
      const methods = async () => {
        const { data } = await api.get(`/store/carts/${chosen}`, store())
        return data.cart.shipping_methods.map((m: any) => [m.shipping_option_id, m.amount])
      }
      expect(await methods()).toEqual([[freeOptionId, 0]])
      await api.post(`/store/carts/${chosen}`, { email: "grace@harness.test" }, store())
      expect(await methods()).toEqual([[freeOptionId, 20]])
    })

    it("reprices the chosen method when an added item takes the cart over the threshold", async () => {
      const cartId = await cartTo("de", 3)
      expect(await addMethod(cartId, freeOptionId)).toEqual([20])
      await api.post(`/store/carts/${cartId}/line-items`, { variant_id: seed.variants.pt, quantity: 1 }, store())
      const { data } = await api.get(`/store/carts/${cartId}`, store())
      expect(data.cart.shipping_methods.map((m: any) => [m.shipping_option_id, m.amount])).toEqual([[freeOptionId, 0]])
    })

    it("still has no price over the weight cap, however large the total", async () => {
      // £60, 2400 g: over the last band.
      const cartId = await cartTo("de", 6)
      const add = (await addMethod(cartId, freeOptionId)) as any
      expect([add.status, add.data.message]).toEqual([400, `Shipping options with IDs ${freeOptionId} do not have a price`])
      expect(((await calculate(freeOptionId, cartId)) as any).status).toBe(400)
    })

    it("shows the band price on /calculate unless the store registers the pricing context helper", async () => {
      const cartId = await cartTo("de", 4)
      expect(await calculate(freeOptionId, cartId)).toBe(20)
      pricingContextHelper = true
      try {
        expect(await calculate(freeOptionId, cartId)).toBe(0)
        expect(await calculate(freeOptionId, await cartTo("de", 3))).toBe(20)
        // The helper reads the discounted total too.
        const discounted = await cartTo("de", 4)
        await withPromotion(discounted)
        expect(await calculate(freeOptionId, discounted)).toBe(20)
        // Over the cap /calculate still refuses: the helper adds item_total
        // alone, so the provider doesn't take /calculate for the listing.
        const heavy = (await calculate(freeOptionId, await cartTo("de", 6))) as any
        expect([heavy.status, heavy.data.message]).toEqual([400, expect.stringMatching(/No standard rate for 2400 g/)])
        // A card without free_over is unchanged.
        expect(await calculate(optionId, await cartTo("de", 5))).toBe(20)
      } finally {
        pricingContextHelper = false
      }
    })

    // Medusa's cart refresh (refreshCartItemsWorkflow) reprices the chosen
    // shipping method before it writes the items' tax lines and recomputes
    // promotions, so the method is priced against the total from before
    // those two steps. One more cart update reprices it against the final
    // total. These pin both sides, so a Medusa that changes the order fails.
    it("prices an added item's method before its tax, until the next cart update", async () => {
      const cartId = await cartTo("is", 1)
      expect(await methodsOf(cartId)).toEqual({ item_total: 15, amounts: [] })
      expect(await addMethod(cartId, freeOptionId)).toEqual([12])
      // A new line of two: £45 with tax, but priced at £15 + £20 untaxed (a
      // quantity added to an existing line is taxed by that line's tax lines).
      await api.post(`/store/carts/${cartId}/line-items`, { variant_id: seed.variants.pt2, quantity: 2 }, store())
      expect(await methodsOf(cartId)).toEqual({ item_total: 45, amounts: [20] })
      await api.post(`/store/carts/${cartId}`, { email: "grace@harness.test" }, store())
      expect(await methodsOf(cartId)).toEqual({ item_total: 45, amounts: [0] })
    })

    it("prices an added item's method before a percentage code applies to it, until the next cart update", async () => {
      const cartId = await cartTo("de", 1)
      await api.post(`/store/carts/${cartId}/promotions`, { promo_codes: ["HALFOFF"] }, store())
      expect(await addMethod(cartId, freeOptionId)).toEqual([12])
      // Four more on the same line: £25 after the code, but priced at £50
      // less the code's £5 for one book.
      await api.post(`/store/carts/${cartId}/line-items`, { variant_id: seed.variants.pt, quantity: 4 }, store())
      expect(await methodsOf(cartId)).toEqual({ item_total: 25, amounts: [0] })
      await api.post(`/store/carts/${cartId}`, { email: "grace@harness.test" }, store())
      expect(await methodsOf(cartId)).toEqual({ item_total: 25, amounts: [20] })
    })

    it("compares a euro cart with the card's euro threshold", async () => {
      const euroCart = async (quantity: number) => {
        const { data } = await api.post(
          "/store/carts",
          {
            region_id: euroRegionId,
            email: "ada@harness.test",
            items: [{ variant_id: seed.variants.pt, quantity }],
            shipping_address: { ...ADDRESS, country_code: "it" },
          },
          store()
        )
        return data.cart.id as string
      }
      // €40 reaches the pound threshold's number, not the euro one.
      expect(await addMethod(await euroCart(4), euroOptionId)).toEqual([15])
      expect(await addMethod(await euroCart(5), euroOptionId)).toEqual([0])
    })

    it("leaves an option without free_over at its band price", async () => {
      expect(await addMethod(await cartTo("de", 5), optionId)).toEqual([20])
    })

    it("edits and removes a threshold through both admin routes", async () => {
      const view = async () => {
        const { data } = await api.get("/admin/print-trail/shipping-options", admin)
        return data.shipping_options.find((o: any) => o.id === freeOptionId).rate_card
      }
      const save = (card: Record<string, unknown>) => api.post(`/admin/print-trail/shipping-options/${freeOptionId}`, { rate_card: card }, admin)
      const core = (body: string) =>
        api.post(`/admin/shipping-options/${freeOptionId}`, body, {
          ...admin,
          ...allow,
          headers: { ...admin.headers, "content-type": "application/json" },
          transformRequest: [(b: string) => b],
        })
      const card = { method: "standard", currency_code: "gbp", bands: DEFAULT_BANDS }

      // Medusa merges data on update; the plugin's route writes null over a
      // dropped currency, and over the map when none is left.
      await save({ ...card, free_over: { gbp: 60, eur: 50 } })
      expect((await view()).free_over).toEqual({ gbp: 60, eur: 50 })
      expect(await addMethod(await cartTo("de", 5), freeOptionId)).toEqual([20])
      await save({ ...card, free_over: { gbp: 50 } })
      expect((await view()).free_over).toEqual({ gbp: 50 })
      expect(await addMethod(await cartTo("de", 5), freeOptionId)).toEqual([0])
      await save(card)
      expect(await view()).not.toHaveProperty("free_over")
      expect(await addMethod(await cartTo("de", 5), freeOptionId)).toEqual([20])

      // Medusa's own route: free_over alone joins the stored card, null
      // removes one, and the merged card is checked.
      expect((await core(`{"data":{"free_over":{"gbp":40}}}`)).status).toBe(200)
      expect((await view()).free_over).toEqual({ gbp: 40 })
      expect(await addMethod(await cartTo("de", 4), freeOptionId)).toEqual([0])
      const bad = [
        [`{"data":{"free_over":{"gbp":-1}}}`, /free_over\.gbp: Too small/],
        [`{"data":{"free_over":{"GBP":30}}}`, /Use a lower-case currency code here \("gbp"\)/],
        [`{"data":{"free_over":{"EUR":null}}}`, /This card has no free-delivery threshold in "EUR" to remove/],
        [`{"data":{"free_over":{"constructor":1,"gbp":30}}}`, /"constructor" isn't allowed in a rate card/],
      ] as const
      for (const [raw, message] of bad) {
        const res = await core(raw)
        expect([raw, res.status, res.data.message]).toEqual([raw, 400, expect.stringMatching(message)])
      }
      expect((await core(`{"data":{"free_over":{"gbp":null}}}`)).status).toBe(200)
      expect(await view()).toEqual(card)
      // null over the whole map removes every threshold.
      expect((await core(`{"data":{"free_over":{"gbp":40,"eur":45}}}`)).status).toBe(200)
      expect((await view()).free_over).toEqual({ gbp: 40, eur: 45 })
      expect((await core(`{"data":{"free_over":null}}`)).status).toBe(200)
      expect(await view()).toEqual(card)
      expect(await addMethod(await cartTo("de", 4), freeOptionId)).toEqual([20])
    })

    it("prices a French address from France's bands and any other country from the default", async () => {
      expect(await price("fr")).toBe(8.25)
      expect(await price("is")).toBe(12)
      expect(await price("de", 3)).toBe(20)
    })

    it("refuses a cart over the destination's last band", async () => {
      // 6 × 400 g = 2400 g, over France's 2 kg.
      const res = (await price("fr", 6)) as any
      expect(res.status).toBe(400)
      expect(res.data.message).toMatch(/No tracked rate for 2400 g to France/)

      // Adding the method: the provider gives no price on the cart's option
      // listing, and Medusa refuses it as having none. A Medusa that stopped
      // passing the listing's fields would answer "No tracked rate…" here.
      const cartId = await cartTo("fr", 6)
      const add = await api.post(`/store/carts/${cartId}/shipping-methods`, { option_id: optionId, data: {} }, { ...store(), ...allow })
      expect(add.status).toBe(400)
      expect(add.data).toEqual({ type: "invalid_data", message: `Shipping options with IDs ${optionId} do not have a price` })
      const { data } = await api.get(`/store/carts/${cartId}`, store())
      expect(data.cart.shipping_methods).toEqual([])

      // Under the limit, the same option is added at France's price.
      const light = await cartTo("fr", 2)
      const ok = await api.post(`/store/carts/${light}/shipping-methods`, { option_id: optionId, data: {} }, store())
      expect(ok.data.cart.shipping_methods.map((m: any) => m.amount)).toEqual([10])
    })

    it("adds an item that takes the cart past the cap, dropping the chosen method", async () => {
      // 4 × 400 g = 1600 g: France's 2 kg band.
      const cartId = await cartTo("fr", 4)
      const pick = await api.post(`/store/carts/${cartId}/shipping-methods`, { option_id: optionId, data: {} }, store())
      expect(pick.data.cart.shipping_methods.map((m: any) => [m.shipping_option_id, m.amount])).toEqual([[optionId, 10]])

      // Two more: 2400 g. Medusa's cart refresh reprices the chosen method;
      // with no price it removes the method rather than refuse the item.
      const added = await api.post(`/store/carts/${cartId}/line-items`, { variant_id: seed.variants.pt, quantity: 2 }, { ...store(), ...allow })
      expect({ status: added.status, message: added.data.message }).toEqual({ status: 200, message: undefined })
      const { data } = await api.get(`/store/carts/${cartId}`, store())
      expect(data.cart.items.map((i: any) => i.quantity)).toEqual([6])
      expect(data.cart.shipping_methods).toEqual([])
      // And the option still can't be chosen again.
      expect(((await price("fr", 6)) as any).status).toBe(400)
    })

    it("prices an under-cap cart on every path", async () => {
      // /calculate, adding the method, then the refresh after a cart change.
      expect(await price("fr", 1)).toBe(8.25)
      const cartId = await cartTo("fr", 1)
      const pick = await api.post(`/store/carts/${cartId}/shipping-methods`, { option_id: optionId, data: {} }, store())
      expect(pick.data.cart.shipping_methods.map((m: any) => m.amount)).toEqual([8.25])
      await api.post(`/store/carts/${cartId}/line-items`, { variant_id: seed.variants.pt, quantity: 1 }, store())
      const { data } = await api.get(`/store/carts/${cartId}`, store())
      // 800 g: France's second band, repriced by the refresh.
      expect(data.cart.shipping_methods.map((m: any) => [m.shipping_option_id, m.amount])).toEqual([[optionId, 10]])
      // An unlisted country prices from the default bands on the add path too.
      const de = await cartTo("de", 1)
      const deAdd = await api.post(`/store/carts/${de}/shipping-methods`, { option_id: optionId, data: {} }, store())
      expect(deAdd.data.cart.shipping_methods.map((m: any) => m.amount)).toEqual([12])
    })

    it("keeps the countries when the default bands are saved, and drops a country the card leaves out", async () => {
      // As the edit drawer saves: the card it was given, new default bands.
      const card = await viewCard()
      await saveCard({ ...card, bands: [{ max_weight: 2000, prices: { gbp: 15 } }] })
      expect(await viewCard()).toEqual({ ...card, bands: [{ max_weight: 2000, prices: { gbp: 15 } }] })
      expect(await price("fr")).toBe(8.25)
      expect(await price("is")).toBe(15)

      // Medusa merges data on update; the route writes null over France.
      await saveCard({ ...card, countries: { de: GERMANY } })
      expect((await viewCard()).countries).toEqual({ de: GERMANY })
      expect(await price("fr")).toBe(12)
      expect(await price("de")).toBe(9)

      await saveCard({ method: "tracked", currency_code: "gbp", bands: DEFAULT_BANDS })
      expect(await viewCard()).not.toHaveProperty("countries")
      expect(await price("de")).toBe(12)
    })

    it("guards Medusa's own route on countries", async () => {
      const bad = await api.post(
        `/admin/shipping-options/${optionId}`,
        { data: { method: "tracked", currency_code: "gbp", bands: DEFAULT_BANDS, countries: { uk: FRANCE } } },
        { ...admin, ...allow }
      )
      expect(bad.status).toBe(400)
      expect(bad.data.message).toMatch(/"uk" isn't an ISO 3166-1 alpha-2 country code/)

      // Medusa merges data, so countries on their own would reach the card unchecked.
      const alone = await api.post(`/admin/shipping-options/${optionId}`, { data: { countries: { xx: FRANCE } } }, { ...admin, ...allow })
      expect(alone.status).toBe(400)
    })

    it("saves through Medusa's own route as Medusa merges it, and prices the result", async () => {
      const core = (data: Record<string, unknown>) => api.post(`/admin/shipping-options/${optionId}`, { data }, { ...admin, ...allow })
      await saveCard({ method: "tracked", currency_code: "gbp", bands: DEFAULT_BANDS })

      // Countries alone join the stored card, one by one.
      expect((await core({ countries: { fr: FRANCE } })).status).toBe(200)
      expect((await core({ countries: { de: GERMANY } })).status).toBe(200)
      expect(await price("fr")).toBe(8.25)
      expect(await price("de")).toBe(9)
      expect(await price("is")).toBe(12)

      // null removes one.
      expect((await core({ countries: { fr: null } })).status).toBe(200)
      expect((await viewCard()).countries).toEqual({ de: GERMANY })
      expect(await price("fr")).toBe(12)

      // A new currency that leaves Germany priced in gbp is refused, and
      // the stored card still prices.
      const eur = await core({ currency_code: "eur", bands: [{ max_weight: null, prices: { eur: 5 } }] })
      expect(eur.status).toBe(400)
      expect(eur.data.message).toMatch(/Germany \(de\): Band 1 needs a price in eur/)
      // An upper-case code would sit beside Medusa's stored lower-case one.
      const upper = await core({ countries: { DE: GERMANY } })
      expect(upper.status).toBe(400)
      expect(upper.data.message).toMatch(/Use a lower-case country code here \("de"\)/)
      // A null that names no stored key would remove nothing.
      const miss = await core({ countries: { DE: null } })
      expect([miss.status, miss.data.message]).toEqual([400, expect.stringMatching(/This card has no country "DE" to remove/)])
      // An own constructor key makes MikroORM replace the object, not merge
      // it. Sent as raw JSON: axios drops an own constructor key, a client
      // that isn't axios needn't.
      const de = JSON.stringify(GERMANY)
      for (const raw of [`{"data":{"constructor":1,"countries":{"is":${de}}}}`, `{"data":{"countries":{"constructor":1,"is":${de}}}}`]) {
        const res = await api.post(`/admin/shipping-options/${optionId}`, raw, {
          ...admin,
          ...allow,
          headers: { ...admin.headers, "content-type": "application/json" },
          transformRequest: [(body: string) => body],
        })
        expect([raw, res.status, res.data.message]).toEqual([raw, 400, expect.stringMatching(/"constructor" isn't allowed in a rate card/)])
      }
      expect(await price("de")).toBe(9)
      expect(await viewCard()).toEqual({ method: "tracked", currency_code: "gbp", bands: DEFAULT_BANDS, countries: { de: GERMANY } })
    })
  },
})
