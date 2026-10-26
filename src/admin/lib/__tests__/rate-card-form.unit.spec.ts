import type { ShippingOptionView } from "../../../lib/admin-types"
import { countryLabel, describeBands, describeCountries, emptyForm, formToRateCard, rateCardToForm, removeCountry, type RateCardForm } from "../rate-card-form"

const form = (over: Partial<RateCardForm> = {}): RateCardForm => ({
  name: "UK tracked",
  service_zone_id: "serzo_1",
  shipping_profile_id: "sp_1",
  method: "tracked",
  currency_code: "GBP",
  bands: [
    { max_weight: "500", price: "3,95" },
    { max_weight: "", price: "8" },
  ],
  ...over,
})

describe("rate-card form", () => {
  it("converts the form to a rate card, keeping prices as entered", () => {
    expect(formToRateCard(form())).toEqual({
      ok: true,
      body: {
        name: "UK tracked",
        service_zone_id: "serzo_1",
        shipping_profile_id: "sp_1",
        rate_card: {
          method: "tracked",
          currency_code: "gbp",
          bands: [
            { max_weight: 500, prices: { gbp: 3.95 } },
            { max_weight: null, prices: { gbp: 8 } },
          ],
        },
      },
    })
  })

  it("rejects an open band that isn't last and a missing price", () => {
    const r = formToRateCard(form({ bands: [{ max_weight: "", price: "1" }, { max_weight: "900", price: "" }] }))
    expect(r).toEqual({
      ok: false,
      errors: { "bands.0.max_weight": "shipping.errors.openBandNotLast", "bands.1.price": "shipping.errors.price" },
    })
    const d = formToRateCard(form({ name: " ", currency_code: "gb", method: "", bands: [{ max_weight: "500", price: "1" }, { max_weight: "400", price: "-1" }] }))
    expect(d).toEqual({
      ok: false,
      errors: {
        name: "shipping.errors.required",
        method: "shipping.errors.required",
        currency_code: "shipping.errors.currency",
        "bands.1.max_weight": "shipping.errors.ascending",
        "bands.1.price": "shipping.errors.price",
      },
    })
    expect(formToRateCard(form({ bands: [] }))).toEqual({ ok: false, errors: { bands: "shipping.errors.noBands" } })
    expect(formToRateCard(form({ bands: [{ max_weight: "abc", price: "1" }] })).ok).toBe(false)
  })

  it("refuses a comma that could be a thousands separator", () => {
    const r = formToRateCard(form({ bands: [{ max_weight: "1,250", price: "1" }, { max_weight: "", price: "2,500" }] }))
    expect(r).toEqual({
      ok: false,
      errors: { "bands.0.max_weight": "shipping.errors.ambiguousComma", "bands.1.price": "shipping.errors.ambiguousComma" },
    })
    const ok = formToRateCard(form({ bands: [{ max_weight: "1250", price: "3,95" }, { max_weight: "", price: "2,5" }] }))
    expect(ok.ok && ok.body.rate_card.bands.map((b) => b.prices.gbp)).toEqual([3.95, 2.5])
  })

  it("round-trips a stored card", () => {
    const stored = {
      id: "so_1",
      name: "UK tracked",
      service_zone: { id: "serzo_1", name: "UK", location: null },
      shipping_profile: { id: "sp_1", name: "PT" },
      price_type: "calculated",
      rate_card: { method: "tracked", currency_code: "gbp", bands: [{ max_weight: 500, prices: { gbp: 3.95 } }, { max_weight: null, prices: { gbp: 8 } }] },
      card_issue: null,
    }
    const f = rateCardToForm(stored)
    const back = formToRateCard(f)
    expect(back.ok && back.body.rate_card).toEqual(stored.rate_card)
    expect(f.bands[0]).toEqual({ max_weight: "500", price: "3.95", other_prices: {} })
    const blank = rateCardToForm({ ...stored, rate_card: null, card_issue: "missing" })
    expect(blank.bands).toEqual(emptyForm().bands)
    expect(blank.name).toBe("UK tracked")
  })

  it("keeps a band's other currencies through an edit", () => {
    const stored: ShippingOptionView = {
      id: "so_1",
      name: "UK tracked",
      service_zone: { id: "serzo_1", name: "UK", location: null },
      shipping_profile: { id: "sp_1", name: "PT" },
      price_type: "calculated",
      rate_card: {
        method: "tracked",
        currency_code: "gbp",
        bands: [
          { max_weight: 500, prices: { gbp: 3.95, eur: 4.5 } },
          { max_weight: null, prices: { gbp: 8, eur: 9, usd: 10 } },
        ],
      },
      card_issue: null,
    }
    const f = rateCardToForm(stored)
    f.bands[0].price = "4.25"
    const out = formToRateCard(f)
    expect(out.ok && out.body.rate_card.bands).toEqual([
      { max_weight: 500, prices: { gbp: 4.25, eur: 4.5 } },
      { max_weight: null, prices: { gbp: 8, eur: 9, usd: 10 } },
    ])
  })

  it("keeps the per-country bands through an edit of the default bands", () => {
    const countries = {
      fr: [
        { max_weight: 250, prices: { gbp: 8.25 } },
        { max_weight: 2000, prices: { gbp: 20 } },
      ],
      is: [{ max_weight: 2000, prices: { gbp: 17.5, eur: 20 } }],
    }
    const stored: ShippingOptionView = {
      id: "so_1",
      name: "International",
      service_zone: { id: "serzo_1", name: "Europe", location: null },
      shipping_profile: { id: "sp_1", name: "PT" },
      price_type: "calculated",
      rate_card: {
        method: "tracked",
        currency_code: "gbp",
        bands: [{ max_weight: 2000, prices: { gbp: 41.5 } }],
        countries,
      },
      card_issue: null,
    }
    const f = rateCardToForm(stored)
    f.bands[0].price = "45"
    f.bands.push({ max_weight: "", price: "60" })
    f.name = "Rest of world"
    const out = formToRateCard(f)
    expect(out.ok && out.body.rate_card).toEqual({
      method: "tracked",
      currency_code: "gbp",
      bands: [
        { max_weight: 2000, prices: { gbp: 45 } },
        { max_weight: null, prices: { gbp: 60 } },
      ],
      countries,
    })
    // A card without countries saves without them.
    const plain = formToRateCard(rateCardToForm({ ...stored, rate_card: { ...stored.rate_card!, countries: undefined } }))
    expect(plain.ok && plain.body.rate_card).not.toHaveProperty("countries")
    expect(formToRateCard(form()).ok && (formToRateCard(form()) as { body: { rate_card: object } }).body.rate_card).not.toHaveProperty("countries")
  })

  it("refuses a currency the per-country bands have no prices in", () => {
    const countries = { fr: [{ max_weight: 2000, prices: { gbp: 8.25 } }], is: [{ max_weight: 2000, prices: { gbp: 17.5, eur: 20 } }] }
    const r = formToRateCard(form({ currency_code: "EUR", bands: [{ max_weight: "", price: "5" }], countries }))
    expect(r).toEqual({ ok: false, errors: { countries: "shipping.errors.countriesCurrency" } })
    // Priced in eur too: fine.
    const both = { fr: [{ max_weight: 2000, prices: { gbp: 8.25, eur: 9.5 } }], is: countries.is }
    expect(formToRateCard(form({ currency_code: "EUR", bands: [{ max_weight: "", price: "5" }], countries: both })).ok).toBe(true)
  })

  it("removes a country, which repairs a card whose country is invalid", () => {
    const f = form({ countries: { fr: [{ max_weight: 2000, prices: { gbp: 8 } }], uk: [{ max_weight: 2000, prices: { gbp: 9 } }] } })
    const out = formToRateCard(removeCountry(f, "uk"))
    expect(out.ok && out.body.rate_card.countries).toEqual({ fr: [{ max_weight: 2000, prices: { gbp: 8 } }] })
    // The last one removed: an empty map, so the route clears them all.
    const none = formToRateCard(removeCountry(removeCountry(f, "uk"), "fr"))
    expect(none.ok && none.body.rate_card.countries).toEqual({})
    expect(f.countries).toHaveProperty("uk")
  })

  it("describes each country's bands, in code order", () => {
    const card = {
      method: "tracked",
      currency_code: "gbp",
      bands: [{ max_weight: null, prices: { gbp: 50 } }],
      countries: {
        is: [{ max_weight: 2000, prices: { gbp: 17.5 } }],
        fr: [
          { max_weight: 250, prices: { gbp: 8.25 } },
          { max_weight: 2000, prices: { gbp: 20 } },
        ],
      },
    }
    expect(describeCountries(card)).toEqual([
      { code: "fr", bands: [{ from: 0, upTo: 250, price: 8.25 }, { from: 250, upTo: 2000, price: 20 }] },
      { code: "is", bands: [{ from: 0, upTo: 2000, price: 17.5 }] },
    ])
    expect(describeCountries({ ...card, countries: undefined })).toEqual([])
  })

  it("labels a country by name and code", () => {
    expect(countryLabel("fr", "en")).toBe("France (FR)")
    expect(countryLabel("is", "en")).toBe("Iceland (IS)")
  })

  it("describes bands", () => {
    expect(
      describeBands({ method: "tracked", currency_code: "gbp", bands: [{ max_weight: 500, prices: { gbp: 3.95 } }, { max_weight: null, prices: { gbp: 8 } }] })
    ).toEqual([
      { from: 0, upTo: 500, price: 3.95 },
      { from: 500, upTo: null, price: 8 },
    ])
  })
})
