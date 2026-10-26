import { FALLBACK_METHODS, priceForWeight, rateCardSchema } from "../rate-card"

// A store's per-country rate cards, by zone: home cards that also list two
// neighbouring countries with their own bands, capped at 5 kg, and
// international cards whose listed countries are capped at 5 kg too. Each
// card must validate against the schema.
type Band = { max_weight: number | null; prices: Record<string, number> }
type Entry = { name: string; description?: string; countries_only?: string[]; card: unknown }

const upTo5kg = (under500g: number, under2kg: number, under5kg: number): Band[] => [
  { max_weight: 500, prices: { eur: under500g } },
  { max_weight: 2000, prices: { eur: under2kg } },
  { max_weight: 5000, prices: { eur: under5kg } },
]
const each = (codes: string[], bands: Band[]) => Object.fromEntries(codes.map((c) => [c, bands]))
const neighbours = ["be", "lu"]
const europe = ["de", "fr", "it", "at", "pl"]

const zones: Record<string, Entry[]> = {
  home: [
    {
      name: "Standard",
      description: "2–4 working days",
      card: {
        method: "standard",
        currency_code: "eur",
        bands: [...upTo5kg(4.2, 6.8, 9.9), { max_weight: null, prices: { eur: 15.5 } }],
        countries: each(neighbours, upTo5kg(5.2, 8.4, 12.6)),
      },
    },
    {
      name: "Express",
      description: "1–2 working days",
      card: {
        method: "express",
        currency_code: "eur",
        bands: [...upTo5kg(7.9, 10.5, 14.2), { max_weight: null, prices: { eur: 21 } }],
        countries: each(neighbours, upTo5kg(9.5, 12.9, 17.4)),
      },
    },
  ],
  europe: [
    {
      name: "Standard",
      description: "3–8 working days",
      countries_only: europe,
      card: {
        method: "standard",
        currency_code: "eur",
        bands: upTo5kg(9.5, 14, 22),
        countries: each(europe, upTo5kg(9.5, 14, 22)),
      },
    },
  ],
  world: [
    {
      name: "Express",
      description: "4–12 working days",
      card: {
        method: "express",
        currency_code: "eur",
        bands: upTo5kg(16, 26, 41),
        countries: each(["us", "ca", "br"], upTo5kg(18, 29, 45)),
      },
    },
  ],
}

describe("per-country rate cards with a 5 kg cap on listed countries", () => {
  const entries = Object.entries(zones).flatMap(([zone, list]) => list.map((e) => [`${zone}: ${e.name}`, e] as const))
  const schema = rateCardSchema(FALLBACK_METHODS)

  it("has cards", () => {
    expect(entries.length).toBeGreaterThan(0)
  })

  it.each(entries)("%s validates", (_, entry) => {
    // Only the card is a rate card; countries_only is the store's zone setup.
    const r = schema.safeParse(entry.card)
    expect(r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([])
  })

  it("lists the neighbouring countries on the home cards", () => {
    expect(zones.home?.length).toBeGreaterThan(0)
    for (const entry of zones.home) {
      const card = schema.parse(entry.card)
      expect(Object.keys(card.countries ?? {})).toEqual(expect.arrayContaining(["be", "lu"]))
    }
  })

  it("prices a listed country up to 5 kg and not above, while the default bands go on", () => {
    const card = schema.parse(zones.home[0].card)
    expect(priceForWeight(card, 1500, "eur", "be")).toBe(8.4)
    expect(priceForWeight(card, 4500, "eur", "lu")).toBe(12.6)
    expect(priceForWeight(card, 5500, "eur", "be")).toBeNull()
    expect(priceForWeight(card, 5500, "eur", "nl")).toBe(15.5)
  })
})
