import path from "node:path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { createRegionsWorkflow } from "@medusajs/medusa/core-flows"
import { useMock } from "./harness"
import { adminHeaders, type Headers } from "./helpers/admin"
import { seedStore, type Seed } from "./helpers/seed"
import { ADDRESS } from "./helpers/store"

jest.setTimeout(120_000)

useMock()

// Per-country bands in a rate card, priced through Medusa's own store routes
// and edited through the plugin's admin route against Medusa's real merge of
// a shipping option's data.
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
    const price = async (country: string, quantity = 1) => {
      const res = await api.post(
        `/store/shipping-options/${optionId}/calculate`,
        { cart_id: await cartTo(country, quantity), data: {} },
        { ...store(), ...allow }
      )
      return res.status === 200 ? (res.data.shipping_option.amount as number) : res
    }
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
