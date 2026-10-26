import { Utils as MikroUtils } from "@mikro-orm/core"
import { PRINT_TRAIL_PROVIDER_ID } from "../../lines"
import { FALLBACK_METHODS } from "../../rate-card"
import {
  createInput,
  guardShippingOptionData,
  knownMethods,
  looksLikeRateCard,
  mergeData,
  rateCardData,
  toShippingOptionView,
  updateData,
  validateRateCard,
} from "../shipping-options"

const card = {
  method: "tracked",
  currency_code: "GBP",
  bands: [
    { max_weight: 500, prices: { gbp: 3.95 } },
    { max_weight: 1000, prices: { gbp: 5.5 } },
    { max_weight: null, prices: { gbp: 8 } },
  ],
}

describe("rate-card admin", () => {
  it("validates a card against the methods Print Trail offers", () => {
    const ok = validateRateCard(card, ["standard", "tracked"])
    expect(ok.ok).toBe(true)
    const bad = validateRateCard(
      { ...card, method: "express", bands: [{ max_weight: 500, prices: { gbp: 1 } }, { max_weight: 400, prices: {} }] },
      ["standard", "tracked"]
    )
    expect(bad.ok).toBe(false)
    const paths = !bad.ok ? bad.issues.map((i) => i.path) : []
    expect(paths).toEqual(expect.arrayContaining(["method", "bands.1.max_weight", "bands.1.prices"]))
    expect(validateRateCard("nope", ["standard"]).ok).toBe(false)
  })

  it("knownMethods falls back to the four methods", async () => {
    expect(await knownMethods(null)).toEqual({ codes: [...FALLBACK_METHODS], source: "fallback" })
    const throwing = { listShippingMethods: async () => Promise.reject(new Error("down")) }
    expect(await knownMethods(throwing)).toEqual({ codes: [...FALLBACK_METHODS], source: "fallback" })
    const two = { listShippingMethods: async () => [{ code: "standard", name: "S" }, { code: null, name: null }, { code: "tracked", name: "T" }] }
    expect(await knownMethods(two)).toEqual({ codes: ["standard", "tracked"], source: "print-trail" })
  })

  it("builds a calculated Print Trail option with Medusa's store rules", () => {
    const valid = validateRateCard(card, ["tracked"])
    if (!valid.ok) throw new Error("expected a valid card")
    const input = createInput({ name: "UK tracked", service_zone_id: "serzo_1", shipping_profile_id: "sp_1", rate_card: card }, valid.card)
    expect(input).not.toHaveProperty("prices")
    expect(input).toMatchInlineSnapshot(`
{
  "data": {
    "bands": [
      {
        "max_weight": 500,
        "prices": {
          "gbp": 3.95,
        },
      },
      {
        "max_weight": 1000,
        "prices": {
          "gbp": 5.5,
        },
      },
      {
        "max_weight": null,
        "prices": {
          "gbp": 8,
        },
      },
    ],
    "currency_code": "gbp",
    "id": "tracked",
    "method": "tracked",
  },
  "name": "UK tracked",
  "price_type": "calculated",
  "provider_id": "print-trail_print-trail",
  "rules": [
    {
      "attribute": "is_return",
      "operator": "eq",
      "value": "false",
    },
    {
      "attribute": "enabled_in_store",
      "operator": "eq",
      "value": "true",
    },
  ],
  "service_zone_id": "serzo_1",
  "shipping_profile_id": "sp_1",
  "type": {
    "code": "tracked",
    "description": "Print Trail",
    "label": "UK tracked",
  },
}
`)
  })

  it("lets Medusa's own fulfilment-option data through", () => {
    const methods = ["standard", "tracked"]
    expect(looksLikeRateCard({ id: "standard", name: "Standard", method: "standard" })).toBe(false)
    expect(guardShippingOptionData({ providerId: PRINT_TRAIL_PROVIDER_ID, data: { id: "standard", name: "Standard", method: "standard" }, methods })).toEqual({ ok: true })
    expect(guardShippingOptionData({ providerId: PRINT_TRAIL_PROVIDER_ID, data: undefined, methods })).toEqual({ ok: true })
    const descending = { ...card, bands: [{ max_weight: 500, prices: { gbp: 1 } }, { max_weight: 100, prices: { gbp: 2 } }] }
    const refused = guardShippingOptionData({ providerId: PRINT_TRAIL_PROVIDER_ID, data: descending, methods })
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.issues[0].path).toBe("bands.1.max_weight")
    expect(guardShippingOptionData({ providerId: "manual_manual", data: descending, methods })).toEqual({ ok: true })
    expect(guardShippingOptionData({ providerId: null, data: descending, methods })).toEqual({ ok: true })
  })

  it("shows an option without a card as missing and a broken one as invalid", () => {
    const base = {
      id: "so_1",
      name: "Std",
      price_type: "calculated",
      service_zone: { id: "serzo_1", name: "UK", fulfillment_set: { name: "Warehouse" } },
      shipping_profile: { id: "sp_1", name: "Print Trail" },
    }
    const missing = toShippingOptionView({ ...base, data: { id: "standard", name: "Standard", method: "standard" } }, ["standard"])
    expect(missing.card_issue).toBe("missing")
    expect(missing.rate_card).toBeNull()
    expect(missing.service_zone).toEqual({ id: "serzo_1", name: "UK", location: "Warehouse" })
    const invalid = toShippingOptionView({ ...base, data: { ...card, method: "air" } }, ["standard"])
    expect(invalid.card_issue).toBe("invalid")
    expect(invalid.rate_card?.method).toBe("air")
    const good = toShippingOptionView({ ...base, data: rateCardData({ ...card, currency_code: "gbp" } as never) }, ["tracked"])
    expect(good.card_issue).toBeNull()
    expect(good.rate_card).toEqual({ ...card, currency_code: "gbp" })
    expect(toShippingOptionView({ id: "so_2", name: "x", price_type: "flat", data: null }, ["standard"])).toMatchObject({
      service_zone: null,
      shipping_profile: null,
      card_issue: "missing",
    })
  })

  describe("per-country bands", () => {
    const fr = [
      { max_weight: 250, prices: { gbp: 8.25 } },
      { max_weight: 2000, prices: { gbp: 20 } },
    ]
    const intl = { ...card, countries: { FR: fr } }
    const base = { id: "so_1", name: "Intl", price_type: "calculated" }

    it("validates and stores countries with the card", () => {
      const valid = validateRateCard(intl, ["tracked"])
      if (!valid.ok) throw new Error("expected a valid card")
      expect(rateCardData(valid.card).countries).toEqual({ fr })
      const input = createInput({ name: "Intl", service_zone_id: "serzo_1", shipping_profile_id: "sp_1" }, valid.card)
      expect(input.data).toMatchObject({ countries: { fr } })
      // A card without countries is stored as before.
      const plain = validateRateCard(card, ["tracked"])
      expect(plain.ok && "countries" in rateCardData(plain.card)).toBe(false)
    })

    it("reports a country's issues by path", () => {
      const bad = validateRateCard({ ...card, countries: { uk: fr, fr: [{ max_weight: 500, prices: { gbp: 1 } }, { max_weight: 400, prices: { gbp: 1 } }] } }, ["tracked"])
      expect(bad.ok).toBe(false)
      const paths = !bad.ok ? bad.issues.map((i) => i.path) : []
      expect(paths).toEqual(expect.arrayContaining(["countries", "countries.fr.1.max_weight"]))
    })

    it("guards Medusa's own routes on countries too", () => {
      const methods = ["tracked"]
      const guard = (data: unknown, stored?: Record<string, unknown> | null) =>
        guardShippingOptionData({ providerId: PRINT_TRAIL_PROVIDER_ID, data, stored, methods })
      expect(guard({ ...card, countries: { fr } })).toEqual({ ok: true })
      const refused = guard({ ...card, countries: { fr: [] } })
      expect(refused.ok).toBe(false)
      expect(!refused.ok && refused.issues[0].path).toBe("countries.fr")
      // Medusa stores the body as sent and merges it key by key: an
      // upper-case code would sit beside the lower-case one.
      const upper = guard(intl)
      expect(upper.ok).toBe(false)
      expect(!upper.ok && upper.issues.map((i) => `${i.path}: ${i.message}`)).toEqual([
        'countries.FR: Use a lower-case country code here ("fr"): Medusa stores the card as sent',
      ])
      // A null removes the stored key it names exactly, an old upper-case
      // one included.
      expect(guard({ countries: { FR: null } }, { ...card, countries: { FR: fr } })).toEqual({ ok: true })
      // One that names no stored key would do nothing, so it is refused.
      const noop = (data: unknown, stored: Record<string, unknown> | null) => {
        const r = guard(data, stored)
        return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`)
      }
      expect(noop({ countries: { FR: null } }, { ...card, countries: { fr } })).toEqual([
        'countries.FR: This card has no country "FR" to remove (country codes are matched exactly)',
      ])
      expect(noop({ countries: { de: null } }, { ...card, countries: { fr } })).toEqual([
        'countries.de: This card has no country "de" to remove (country codes are matched exactly)',
      ])
      expect(noop({ ...card, countries: { fr, de: null } }, null)).toEqual([
        'countries.de: This card has no country "de" to remove (country codes are matched exactly)',
      ])
      expect(noop({ countries: { de: null } }, { ...card, countries: null })).toHaveLength(1)
    })

    it("checks the card Medusa will store: the body merged over the stored data", () => {
      const methods = ["tracked"]
      const stored = rateCardData({ ...card, currency_code: "gbp", countries: { fr } } as never)
      const guard = (data: unknown, from: Record<string, unknown> | null = stored) =>
        guardShippingOptionData({ providerId: PRINT_TRAIL_PROVIDER_ID, data, stored: from, methods })

      // A new currency with new default bands leaves France priced in gbp.
      const eur = guard({ ...card, currency_code: "eur", bands: [{ max_weight: null, prices: { eur: 5 } }] })
      expect(eur.ok).toBe(false)
      expect(!eur.ok && eur.issues.map((i) => i.path)).toEqual(["countries.fr.0.prices", "countries.fr.1.prices"])
      // Countries alone are added to the stored card, and checked with it.
      expect(guard({ countries: { de: fr } })).toEqual({ ok: true })
      expect(guard({ countries: { fr: null } })).toEqual({ ok: true })
      const xx = guard({ countries: { xx: fr } })
      expect(!xx.ok && xx.issues.map((i) => i.path)).toEqual(["countries"])
      // Medusa's own form data merges over a card harmlessly.
      expect(guard({ id: "tracked", name: "Tracked", method: "tracked" })).toEqual({ ok: true })
      // Countries with no card to join, on create or over a card-less option.
      for (const from of [null, { id: "tracked", name: "Tracked", method: "tracked" }]) {
        const alone = guard({ countries: { de: fr } }, from)
        expect(alone.ok).toBe(false)
        expect(!alone.ok && alone.issues[0]).toEqual({
          path: "countries",
          message: "countries needs a rate card to join: send method, currency_code and bands with it, or update an option that has a card",
        })
      }
    })

    it("merges as Medusa does: objects key by key, anything else replaced", () => {
      expect(mergeData({ a: { b: 1, c: [1, 2] }, d: 1 }, { a: { c: [3] }, e: null })).toEqual({ a: { b: 1, c: [3] }, d: 1, e: null })
      expect(mergeData({ a: { b: 1 } }, { a: null })).toEqual({ a: null })
      expect(mergeData({ a: null }, { a: { b: 1 } })).toEqual({ a: { b: 1 } })
      expect(mergeData(null, { a: 1 })).toEqual({ a: 1 })
      const stored = { a: { b: 1 } }
      mergeData(stored, { a: { b: 2 } })
      expect(stored).toEqual({ a: { b: 1 } })
      expect(Object.prototype).not.toHaveProperty("polluted")
      mergeData({}, JSON.parse('{"__proto__": {"polluted": 1}}'))
      expect(Object.prototype).not.toHaveProperty("polluted")
    })

    // The same cases through MikroORM itself, as Medusa's update assigns
    // data (EntityAssigner.assignProperty with mergeObjectProperties: merge
    // only when both sides are Utils.isPlainObject, else replace).
    it("matches MikroORM's merge, own constructor keys included", () => {
      const mikro = (stored: unknown, body: unknown) =>
        MikroUtils.isPlainObject(stored) && MikroUtils.isPlainObject(body)
          ? MikroUtils.merge({}, stored as object, body as object)
          : body
      const intlCard = { method: "tracked", currency_code: "gbp", bands: card.bands, countries: { fr, de: fr } }
      const cases: [Record<string, unknown> | null, string][] = [
        [intlCard, '{"countries":{"is":[{"max_weight":null,"prices":{"gbp":1}}]}}'],
        [intlCard, '{"countries":{"fr":null},"bands":[{"max_weight":null,"prices":{"gbp":2}}]}'],
        [intlCard, '{"currency_code":"eur"}'],
        [intlCard, '{"constructor":1,"countries":{"is":[]}}'],
        [intlCard, '{"countries":{"constructor":1,"is":[]}}'],
        [intlCard, '{"countries":{"constructor":{"a":1},"is":[]}}'],
        [intlCard, '{"__proto__":{"x":1},"countries":{"is":[]}}'],
        [intlCard, '{"prototype":1,"method":"standard"}'],
        [{ ...intlCard, countries: null }, '{"countries":{"is":[]}}'],
        [null, '{"countries":{"is":[]}}'],
        [{ id: "tracked", name: "Tracked", method: "tracked" }, '{"bands":[]}'],
      ]
      for (const [stored, body] of cases) {
        const expected = mikro(stored === null ? null : structuredClone(stored), JSON.parse(body))
        expect([body, mergeData(stored, JSON.parse(body))]).toEqual([body, expected])
      }
    })

    it("refuses constructor, __proto__ and prototype keys anywhere in a card", () => {
      const stored = rateCardData({ ...card, currency_code: "gbp", countries: { fr } } as never)
      for (const body of [
        '{"constructor":1,"countries":{"de":[{"max_weight":null,"prices":{"gbp":1}}]}}',
        '{"countries":{"constructor":1,"de":[{"max_weight":null,"prices":{"gbp":1}}]}}',
        '{"__proto__":{"x":1},"method":"tracked"}',
        '{"bands":[{"max_weight":null,"prices":{"gbp":1},"prototype":1}]}',
      ]) {
        const r = guardShippingOptionData({ providerId: PRINT_TRAIL_PROVIDER_ID, data: JSON.parse(body), stored, methods: ["tracked"] })
        expect([body, r.ok]).toEqual([body, false])
        expect(!r.ok && r.issues.some((i) => /isn't allowed in a rate card/.test(i.message))).toBe(true)
      }
    })

    // Medusa merges data on update: a country left out of the new card would
    // survive, so the update writes null over each one dropped.
    it("replaces the stored countries on update", () => {
      const valid = (c: unknown) => {
        const v = validateRateCard(c, ["tracked"])
        if (!v.ok) throw new Error("expected a valid card")
        return v.card
      }
      const stored = rateCardData(valid({ ...card, countries: { fr, de: fr } }))
      expect(updateData(stored, valid({ ...card, countries: { fr } })).countries).toEqual({ fr, de: null })
      expect(updateData(stored, valid(card)).countries).toBeNull()
      expect(updateData(stored, valid({ ...card, countries: { fr, de: fr } })).countries).toEqual({ fr, de: fr })
      expect(updateData(rateCardData(valid(card)), valid(card))).not.toHaveProperty("countries")
      expect(updateData(null, valid({ ...card, countries: { fr } })).countries).toEqual({ fr })
      expect(updateData({ id: "standard", method: "standard" }, valid(card))).not.toHaveProperty("countries")
    })

    it("shows countries on the option view, valid or not", () => {
      const good = toShippingOptionView({ ...base, data: intl }, ["tracked"])
      expect(good.card_issue).toBeNull()
      expect(good.rate_card?.countries).toEqual({ fr })
      expect(toShippingOptionView({ ...base, data: card }, ["tracked"]).rate_card).not.toHaveProperty("countries")
      const invalid = toShippingOptionView({ ...base, data: { ...intl, method: "air", countries: { FR: fr, de: null } } }, ["tracked"])
      expect(invalid.card_issue).toBe("invalid")
      expect(invalid.rate_card?.countries).toEqual({ FR: fr })
      expect(toShippingOptionView({ ...base, data: { ...card, countries: { de: null } } }, ["tracked"]).rate_card?.countries).toEqual({})
    })
  })

  it("keeps prices as entered", () => {
    const valid = validateRateCard(card, ["tracked"])
    if (!valid.ok) throw new Error("expected a valid card")
    expect(valid.card.bands[0].prices.gbp).toBe(3.95)
    expect((rateCardData(valid.card).bands as { prices: Record<string, number> }[])[0].prices.gbp).toBe(3.95)
  })
})
