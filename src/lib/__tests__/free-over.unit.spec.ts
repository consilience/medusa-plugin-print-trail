import { printTrailCalculatedShippingContext } from "../../shipping-options"
import { currencyDigits, freeOverThreshold, priceFor, rateCardSchema, readTotal, roundToCurrency, type RateCard } from "../rate-card"

// Free delivery over a cart's item total, per currency, on a rate card.
const schema = rateCardSchema(["standard"])
const bands = [
  { max_weight: 1000, prices: { gbp: 3.95, eur: 4.5 } },
  { max_weight: 2000, prices: { gbp: 5.5, eur: 6 } },
]
const card = (free_over?: unknown): RateCard =>
  schema.parse({ method: "standard", currency_code: "gbp", bands, ...(free_over !== undefined ? { free_over } : {}) })
const issues = (data: unknown) => {
  const r = schema.safeParse(data)
  return r.success ? [] : r.error.issues.map((i) => i.message)
}

describe("free_over in a rate card", () => {
  it("keeps the thresholds, lower-cased, through the schema", () => {
    expect(card({ GBP: 40, eur: 45.5 }).free_over).toEqual({ gbp: 40, eur: 45.5 })
  })

  it("reads missing, null, empty and null currencies as no threshold", () => {
    for (const value of [undefined, null, {}, { gbp: null }]) {
      expect(card(value)).not.toHaveProperty("free_over")
    }
    expect(card({ gbp: null, eur: 45 }).free_over).toEqual({ eur: 45 })
  })

  it("refuses a negative amount, a bad code and two keys that differ only in case", () => {
    const base = { method: "standard", currency_code: "gbp", bands }
    expect(issues({ ...base, free_over: { gbp: -1 } })).toHaveLength(1)
    expect(issues({ ...base, free_over: { gbp: "40" } })).toHaveLength(1)
    expect(issues({ ...base, free_over: { pounds: 40 } })).toHaveLength(1)
    expect(issues({ ...base, free_over: { gbp: 40, GBP: 50 } })).toEqual(["gbp has more than one free-delivery threshold"])
    // A null beside its other case is a removal, not a second threshold.
    expect(issues({ ...base, free_over: { gbp: 40, GBP: null } })).toEqual([])
  })

  it("finds a threshold by own key only, in any case", () => {
    const c = card({ gbp: 40 })
    expect(freeOverThreshold(c, "GBP")).toBe(40)
    expect(freeOverThreshold(c, "eur")).toBeNull()
    expect(freeOverThreshold(c, "constructor")).toBeNull()
    expect(freeOverThreshold(card(), "gbp")).toBeNull()
  })
})

describe("priceFor", () => {
  const c = card({ gbp: 40 })
  const at = (itemTotal: number | null | undefined, currency = "gbp", grams = 1500) => priceFor(c, { grams, currency, itemTotal })

  it("is the band price below the threshold and 0 at or above it", () => {
    expect(at(39.99)).toBe(5.5)
    expect(at(40)).toBe(0)
    expect(at(120)).toBe(0)
  })

  it("compares only with the threshold in the pricing currency", () => {
    // The card's currency has one, eur has none.
    expect(at(100, "eur")).toBe(6)
    const both = card({ gbp: 40, eur: 50 })
    expect(priceFor(both, { grams: 500, currency: "eur", itemTotal: 49 })).toBe(4.5)
    expect(priceFor(both, { grams: 500, currency: "EUR", itemTotal: 50 })).toBe(0)
  })

  it("is the band price with no item total", () => {
    expect(at(undefined)).toBe(5.5)
    expect(at(null)).toBe(5.5)
    // Even a threshold of 0 needs a total to compare.
    expect(priceFor(card({ gbp: 0 }), { grams: 500, currency: "gbp" })).toBe(3.95)
    expect(priceFor(card({ gbp: 0 }), { grams: 500, currency: "gbp", itemTotal: 0 })).toBe(0)
  })

  it("still has no price over the weight cap", () => {
    expect(at(500, "gbp", 2500)).toBeNull()
  })

  it("rounds the item total to the currency's precision before comparing", () => {
    // 39.996 is shown as £40.00, so it reaches £40; 39.994 is £39.99.
    expect(at(39.996)).toBe(0)
    expect(at(39.994)).toBe(5.5)
    const yen = schema.parse({ method: "standard", currency_code: "jpy", bands: [{ max_weight: null, prices: { jpy: 500 } }], free_over: { jpy: 5000 } })
    expect(priceFor(yen, { grams: 100, currency: "jpy", itemTotal: 4999.5 })).toBe(0)
    expect(priceFor(yen, { grams: 100, currency: "jpy", itemTotal: 4999.4 })).toBe(500)
  })

  it("leaves a card without free_over at its band price", () => {
    expect(priceFor(card(), { grams: 1500, currency: "gbp", itemTotal: 1000 })).toBe(5.5)
  })

  it("uses the destination's bands as before", () => {
    const fr = schema.parse({
      method: "standard",
      currency_code: "gbp",
      bands,
      countries: { fr: [{ max_weight: 500, prices: { gbp: 8 } }] },
      free_over: { gbp: 40 },
    })
    expect(priceFor(fr, { grams: 400, currency: "gbp", country: "fr", itemTotal: 10 })).toBe(8)
    expect(priceFor(fr, { grams: 400, currency: "gbp", country: "fr", itemTotal: 40 })).toBe(0)
    expect(priceFor(fr, { grams: 600, currency: "gbp", country: "fr", itemTotal: 40 })).toBeNull()
  })
})

describe("roundToCurrency", () => {
  it("uses the currency's minor units, else 2", () => {
    expect([currencyDigits("gbp"), currencyDigits("JPY"), currencyDigits("kwd"), currencyDigits("x!")]).toEqual([2, 0, 3, 2])
    expect(roundToCurrency(39.996, "gbp")).toBe(40)
    expect(roundToCurrency(1.005, "gbp")).toBe(1.01)
    expect(roundToCurrency(4999.5, "jpy")).toBe(5000)
    expect(roundToCurrency(1.0005, "kwd")).toBe(1.001)
    // Any finite number, however small or large.
    expect(roundToCurrency(1e-7, "gbp")).toBe(0)
    expect(roundToCurrency(1e-7, "jpy")).toBe(0)
    expect(roundToCurrency(1e21, "gbp")).toBe(1e21)
    expect(roundToCurrency(1000.005, "gbp")).toBe(1000.01)
    expect(priceFor(card({ gbp: 0 }), { grams: 500, currency: "gbp", itemTotal: 1e-7 })).toBe(0)
  })
})

describe("readTotal", () => {
  it("reads a number, a decimal string or a BigNumber-like value", () => {
    expect(readTotal(40)).toBe(40)
    expect(readTotal("39.5")).toBe(39.5)
    expect(readTotal({ valueOf: () => 41.25 })).toBe(41.25)
  })

  it("reads anything else as no total", () => {
    for (const value of [undefined, null, "", "  ", true, false, NaN, Infinity, "forty", { value: "40" }]) {
      expect(readTotal(value)).toBeNull()
    }
  })
})

describe("printTrailCalculatedShippingContext", () => {
  const container = (rows: unknown[]) => {
    const graph = jest.fn(async () => ({ data: rows }))
    return { graph, container: { resolve: jest.fn(() => ({ graph })) } as any }
  }

  it("returns the cart's item total and nothing else", async () => {
    const { graph, container: c } = container([{ id: "cart_1", item_total: { valueOf: () => 42.5 } }])
    const result = await printTrailCalculatedShippingContext({ input: { cart_id: "cart_1" } }, { container: c })
    expect(result.output).toEqual({ item_total: 42.5 })
    expect(graph).toHaveBeenCalledWith({ entity: "cart", fields: ["id", "item_total"], filters: { id: "cart_1" } })
  })

  it("returns nothing without a cart id, and reads nothing", async () => {
    for (const input of [{}, { cart_id: "" }, { cart_id: null }, undefined]) {
      const { graph, container: c } = container([{ id: "cart_1", item_total: 50 }])
      expect((await printTrailCalculatedShippingContext({ input } as any, { container: c })).output).toEqual({})
      expect(graph).not.toHaveBeenCalled()
    }
  })

  it("returns nothing for a missing cart or total", async () => {
    for (const rows of [[], [{ id: "cart_1" }], [{ id: "cart_1", item_total: null }]]) {
      const { container: c } = container(rows)
      expect((await printTrailCalculatedShippingContext({ input: { cart_id: "cart_1" } }, { container: c })).output).toEqual({})
    }
  })
})
