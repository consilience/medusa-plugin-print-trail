import {
  bandsFor,
  cartWeight,
  FALLBACK_METHODS,
  priceForWeight,
  rateCardSchema,
  type RateCard,
} from "../rate-card"

const card: RateCard = {
  method: "tracked",
  currency_code: "gbp",
  bands: [
    { max_weight: 500, prices: { gbp: 3.95, usd: 5 } },
    { max_weight: 1000, prices: { gbp: 5.5 } },
    { max_weight: null, prices: { gbp: 8.95 } },
  ],
}

const schema = rateCardSchema(FALLBACK_METHODS)
const issues = (data: unknown, s = schema) => {
  const r = s.safeParse(data)
  return r.success ? "" : r.error.issues.map((i) => i.message).join(" | ")
}

describe("rate card currencies", () => {
  const schema = rateCardSchema(["tracked"])
  it("requires a three-letter currency code", () => {
    for (const code of ["gbpx", "g1p", "€€€", "gb "]) {
      expect(schema.safeParse({ method: "tracked", currency_code: code, bands: [{ max_weight: null, prices: { [code]: 1 } }] }).success).toBe(false)
    }
    expect(schema.safeParse({ method: "tracked", currency_code: "GBP", bands: [{ max_weight: null, prices: { gbp: 1 } }] }).success).toBe(true)
  })

  it("checks the card's currency code on its own", () => {
    // The prices are valid; only currency_code is wrong.
    const r = schema.safeParse({ method: "tracked", currency_code: "gbpx", bands: [{ max_weight: null, prices: { gbp: 1 } }] })
    expect(r.success).toBe(false)
    expect(!r.success && r.error.issues.map((i) => i.path.join("."))).toContain("currency_code")
  })

  it("rejects price keys that collide once lowercased", () => {
    const r = schema.safeParse({ method: "tracked", currency_code: "gbp", bands: [{ max_weight: null, prices: { GBP: 1, gbp: 2 } }] })
    expect(r.success).toBe(false)
    expect(!r.success && r.error.issues.map((i) => i.path.join("."))).toContain("bands.0.prices")
    expect(schema.safeParse({ method: "tracked", currency_code: "gbp", bands: [{ max_weight: null, prices: { gbp: 1, e: 2 } }] }).success).toBe(false)
  })
})

describe("cartWeight", () => {
  it("takes a variant weight of 0 as real, not as missing", () => {
    expect(cartWeight([{ id: "a", quantity: 2, variant: { weight: 0 }, product: { weight: 400 } }])).toEqual({ grams: 0, missing: [] })
  })

  it("falls back to the product's weight", () => {
    expect(
      cartWeight([
        { id: "a", quantity: 1, variant: { weight: null }, product: { weight: 400 } },
        { id: "b", quantity: 2, variant: { weight: 100 }, product: { weight: 999 } },
        { id: "c", quantity: 1, variant: { weight: null }, product: { weight: null } },
        { id: "d", quantity: 1, variant: null, product: null },
      ])
    ).toEqual({ grams: 600, missing: ["c", "d"] })
  })

  it("sums variant weight × quantity in grams", () => {
    expect(
      cartWeight([
        { quantity: 2, variant: { weight: 240 } },
        { quantity: "1", variant: { weight: 410 } },
      ])
    ).toEqual({ grams: 890, missing: [] })
  })

  it("counts unweighted variants as 0 and reports them", () => {
    expect(cartWeight([{ id: "item_1", quantity: 3, variant: { weight: null } }])).toEqual({
      grams: 0,
      missing: ["item_1"],
    })
  })
})

describe("priceForWeight", () => {
  it("picks the first band whose max_weight covers the weight", () => {
    expect(priceForWeight(card, 500, "gbp")).toBe(3.95)
    expect(priceForWeight(card, 501, "gbp")).toBe(5.5)
  })

  it("uses the open-ended band above the last limit, any currency case", () => {
    expect(priceForWeight(card, 25000, "GBP")).toBe(8.95)
  })

  it("returns null without a price in the currency, or without a covering band", () => {
    expect(priceForWeight(card, 800, "usd")).toBeNull()
    expect(priceForWeight({ ...card, bands: card.bands.slice(0, 2) }, 2000, "gbp")).toBeNull()
  })
})

describe("rateCardSchema", () => {
  it("accepts a well-formed card and stores prices as they are", () => {
    const r = schema.parse(card)
    expect(r.bands[0].prices.gbp).toBe(3.95)
  })

  it("normalises currency codes to lower case", () => {
    const r = schema.parse({
      ...card,
      currency_code: "GBP",
      bands: [{ max_weight: null, prices: { GBP: 4 } }],
    })
    expect(r.currency_code).toBe("gbp")
    expect(r.bands[0].prices).toEqual({ gbp: 4 })
  })

  it("rejects a method the channel does not offer", () => {
    expect(issues(card, rateCardSchema(["standard"]))).not.toBe("")
    expect(issues({ ...card, method: "tracked-48" })).not.toBe("")
  })

  it("rejects bands out of ascending order", () => {
    expect(
      issues({
        ...card,
        bands: [
          { max_weight: 1000, prices: { gbp: 5 } },
          { max_weight: 500, prices: { gbp: 3 } },
        ],
      })
    ).toMatch(/ascending/)
  })

  it("rejects an open-ended band that is not last", () => {
    expect(
      issues({
        ...card,
        bands: [
          { max_weight: null, prices: { gbp: 5 } },
          { max_weight: 500, prices: { gbp: 3 } },
        ],
      })
    ).toMatch(/last/)
  })

  it("rejects negative prices, empty bands and a missing currency", () => {
    expect(issues({ ...card, bands: [{ max_weight: null, prices: { gbp: -1 } }] })).not.toBe("")
    expect(issues({ ...card, bands: [] })).not.toBe("")
    expect(issues({ method: "standard", bands: card.bands })).not.toBe("")
  })

  it("requires a price in the card's currency in every band", () => {
    expect(
      issues({ ...card, currency_code: "eur", bands: [{ max_weight: null, prices: { gbp: 5 } }] })
    ).toMatch(/eur/)
  })
})

describe("per-country bands", () => {
  const france = [
    { max_weight: 250, prices: { gbp: 8.25 } },
    { max_weight: 2000, prices: { gbp: 20 } },
  ]
  const intl = {
    method: "tracked",
    currency_code: "gbp",
    bands: [
      { max_weight: 250, prices: { gbp: 17.5 } },
      { max_weight: 2000, prices: { gbp: 41.5 } },
    ],
    countries: { fr: france },
  }
  const paths = (data: unknown) => {
    const r = schema.safeParse(data)
    return r.success ? [] : r.error.issues.map((i) => i.path.join("."))
  }

  it("leaves a card without countries as it was", () => {
    const r = schema.parse(card)
    expect(r).toEqual(card)
    expect("countries" in r).toBe(false)
  })

  it("accepts a countries map of band lists", () => {
    const r = schema.parse(intl)
    expect(r.countries).toEqual({ fr: france })
    expect(schema.parse({ ...intl, countries: {} }).countries).toEqual({})
  })

  it("normalises country codes and their prices to lower case", () => {
    const r = schema.parse({ ...intl, countries: { FR: [{ max_weight: null, prices: { GBP: 9 } }] } })
    expect(r.countries).toEqual({ fr: [{ max_weight: null, prices: { gbp: 9 } }] })
  })

  it("rejects codes that collide once lowercased", () => {
    expect(paths({ ...intl, countries: { FR: france, fr: france } })).toContain("countries")
  })

  it("rejects a code that isn't an ISO 3166-1 alpha-2 country", () => {
    for (const code of ["uk", "xx", "fra", "f", "1a", ""]) {
      expect(paths({ ...intl, countries: { [code]: france } })).toContain("countries")
    }
    expect(issues({ ...intl, countries: { uk: france } })).toMatch(/uk/)
    // Crown dependencies and Kosovo are in Medusa's list.
    expect(schema.safeParse({ ...intl, countries: { im: france, je: france, gg: france, xk: france } }).success).toBe(true)
  })

  it("checks each country's bands like the default bands", () => {
    expect(paths({ ...intl, countries: { fr: [] } })).toContain("countries.fr")
    expect(
      paths({ ...intl, countries: { fr: [{ max_weight: 500, prices: { gbp: 1 } }, { max_weight: 250, prices: { gbp: 2 } }] } })
    ).toContain("countries.fr.1.max_weight")
    expect(
      paths({ ...intl, countries: { fr: [{ max_weight: null, prices: { gbp: 1 } }, { max_weight: 250, prices: { gbp: 2 } }] } })
    ).toContain("countries.fr.0.max_weight")
    expect(paths({ ...intl, countries: { fr: [{ max_weight: null, prices: { eur: 1 } }] } })).toContain("countries.fr.0.prices")
    expect(issues({ ...intl, countries: { fr: [{ max_weight: null, prices: { eur: 1 } }] } })).toMatch(/France|fr/)
    expect(paths({ ...intl, countries: { fr: [{ max_weight: null, prices: { gbp: -1 } }] } })).toContain("countries.fr.0.prices.gbp")
    expect(paths({ ...intl, countries: { fr: [{ max_weight: null, prices: { GBP: 1, gbp: 2 } }] } })).toContain("countries.fr.0.prices")
    expect(paths({ ...intl, countries: { fr: "x" } })).toContain("countries.fr")
    expect(paths({ ...intl, countries: [] })).toContain("countries")
  })

  // Medusa merges a shipping option's data on update, so a country is
  // removed by writing null over it.
  it("reads a null country, or null countries, as not listed", () => {
    expect(schema.parse({ ...intl, countries: { fr: france, de: null } }).countries).toEqual({ fr: france })
    expect(schema.parse({ ...intl, countries: { FR: null, fr: france } }).countries).toEqual({ fr: france })
    expect(schema.parse({ ...intl, countries: { de: null } }).countries).toEqual({})
    expect("countries" in schema.parse({ ...intl, countries: null })).toBe(false)
  })

  it("picks the destination's bands, and the default for any other country", () => {
    const r = schema.parse(intl)
    expect(bandsFor(r, "fr")).toBe(r.countries!.fr)
    expect(bandsFor(r, "FR")).toBe(r.countries!.fr)
    expect(bandsFor(r, "is")).toBe(r.bands)
    expect(bandsFor(r, null)).toBe(r.bands)
    expect(bandsFor(card, "fr")).toBe(card.bands)
    // Only the card's own keys: a country_code naming an Object property is
    // just an unlisted country.
    for (const code of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(bandsFor(r, code)).toBe(r.bands)
      expect(priceForWeight(r, 250, "gbp", code)).toBe(17.5)
    }
    expect(priceForWeight(r, 250, "gbp", "fr")).toBe(8.25)
    expect(priceForWeight(r, 250, "gbp", "is")).toBe(17.5)
    expect(priceForWeight(r, 250, "gbp")).toBe(17.5)
    // The last limit is inclusive per country too.
    expect(priceForWeight(r, 2000, "gbp", "fr")).toBe(20)
    // Over the country's last band: no price, even when the default would cover it.
    const roomy = schema.parse({ ...intl, bands: [{ max_weight: null, prices: { gbp: 50 } }] })
    expect(priceForWeight(roomy, 2001, "gbp", "fr")).toBeNull()
    expect(priceForWeight(roomy, 2001, "gbp", "de")).toBe(50)
  })
})
