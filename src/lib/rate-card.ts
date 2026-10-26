import { defaultCountries } from "@medusajs/framework/utils"
import { z } from "@medusajs/framework/zod"

// Weight-band shipping rate cards. Each Print Trail shipping option stores one
// card in its `data`: the zone comes from the option's service zone, the
// method from `method`, the band list from the destination country
// (`countries`, else `bands`), the band from the cart's weight. Prices are major
// units, stored as they are (3.95 is £3.95).

// Print Trail's accepted codes, used when GET /shipping-methods can't be reached.
export const FALLBACK_METHODS = ["standard", "express", "air", "tracked"] as const

const CURRENCY = /^[a-z]{3}$/i

const lowerKeys = (prices: Record<string, number>) =>
  Object.fromEntries(Object.entries(prices).map(([k, v]) => [k.toLowerCase(), v]))

// ISO 3166-1 alpha-2, as Medusa lists them (its regions take countries from
// the same list, so a card can't name a country no region could hold).
const COUNTRY_NAMES = new Map(defaultCountries.map((c) => [c.alpha2.toLowerCase(), c.name]))

export const countryName = (code: string) => COUNTRY_NAMES.get(code.toLowerCase()) ?? code.toUpperCase()

const bandsSchema = z
  .array(
    z.object({
      // Inclusive upper limit in grams; null means no limit (last band only).
      max_weight: z.number().positive().nullable(),
      prices: z
        .record(z.string().regex(CURRENCY, "Use three-letter currency codes"), z.number().nonnegative())
        .superRefine((prices, ctx) => {
          const seen = new Set<string>()
          for (const code of Object.keys(prices)) {
            const lower = code.toLowerCase()
            if (seen.has(lower)) ctx.addIssue({ code: "custom", message: `${lower} has more than one price` })
            seen.add(lower)
          }
        })
        .transform(lowerKeys),
    })
  )
  .min(1)

type Bands = z.infer<typeof bandsSchema>

const listed = (countries: Record<string, Bands | null>) =>
  Object.entries(countries).filter((e): e is [string, Bands] => e[1] !== null)

// The band rules, for the default bands and for each country's.
function checkBands(bands: Bands, currency: string, path: (string | number)[], label: string, ctx: z.RefinementCtx) {
  let previous = 0
  bands.forEach((band, i) => {
    if (band.max_weight === null) {
      if (i !== bands.length - 1) {
        ctx.addIssue({ code: "custom", path: [...path, i, "max_weight"], message: `${label}Only the last band may have no weight limit` })
      }
    } else if (band.max_weight <= previous) {
      ctx.addIssue({ code: "custom", path: [...path, i, "max_weight"], message: `${label}Band weight limits must be ascending` })
    } else {
      previous = band.max_weight
    }
    if (typeof band.prices[currency] !== "number") {
      ctx.addIssue({ code: "custom", path: [...path, i, "prices"], message: `${label}Band ${i + 1} needs a price in ${currency}` })
    }
  })
}

export function rateCardSchema(methods: readonly string[]) {
  return z
    .object({
      method: z.enum(methods as [string, ...string[]]),
      // The card carries its currency because the calculate route passes none.
      currency_code: z
        .string()
        .regex(CURRENCY, "Use a three-letter currency code")
        .transform((c) => c.toLowerCase()),
      // The bands for any destination not in `countries`.
      bands: bandsSchema,
      // Bands for particular destinations, keyed by ISO 3166-1 alpha-2 code.
      // Upper-case codes are accepted and stored lower-case, as currency
      // codes are; two keys that differ only in case are refused. A null
      // country, or null countries, is not listed: Medusa merges a shipping
      // option's data on update, so null is how a country is removed.
      countries: z
        .record(z.string(), bandsSchema.nullable())
        .superRefine((countries, ctx) => {
          const seen = new Set<string>()
          for (const [code] of listed(countries)) {
            const lower = code.toLowerCase()
            if (!COUNTRY_NAMES.has(lower)) {
              ctx.addIssue({ code: "custom", message: `"${code}" isn't an ISO 3166-1 alpha-2 country code` })
            } else if (seen.has(lower)) {
              ctx.addIssue({ code: "custom", message: `${lower} has more than one band list` })
            }
            seen.add(lower)
          }
        })
        .transform((countries) => Object.fromEntries(listed(countries).map(([k, v]) => [k.toLowerCase(), v])))
        .nullish(),
    })
    .superRefine((card, ctx) => {
      checkBands(card.bands, card.currency_code, ["bands"], "", ctx)
      // Zod still runs this when the map's own checks failed, untransformed.
      for (const [code, bands] of listed(card.countries ?? {})) {
        checkBands(bands, card.currency_code, ["countries", code], `${countryName(code)} (${code}): `, ctx)
      }
    })
    .transform(({ countries, ...card }): typeof card & { countries?: Record<string, Bands> } =>
      countries ? { ...card, countries } : card
    )
}

export type RateCard = z.infer<ReturnType<typeof rateCardSchema>>

type WeighableItem = {
  id?: string
  quantity: number | string | { toString(): string }
  variant?: { weight?: number | null } | null
  // The calculate context selects items.product.weight too (2.17.2
  // cartFieldsForCalculateShippingOptionsPrices).
  product?: { weight?: number | null } | null
}

export function cartWeight(items: WeighableItem[]): { grams: number; missing: string[] } {
  let grams = 0
  const missing: string[] = []
  for (const item of items) {
    // Grams, as Medusa stores them. Only a missing variant weight (Medusa's
    // default is null) falls back to the product's; 0 is a real weight.
    const weight = item.variant?.weight ?? item.product?.weight
    if (weight == null) {
      missing.push(item.id ?? "unknown")
      continue
    }
    grams += Number(weight) * Number(item.quantity)
  }
  return { grams, missing }
}

// The destination's own bands when the card lists it, else the default.
export function bandsFor(card: RateCard, country?: string | null): RateCard["bands"] {
  // Own keys only: "constructor" or "__proto__" from an address is an
  // unlisted country, not Object's.
  const code = country?.toLowerCase()
  return code && card.countries && Object.prototype.hasOwnProperty.call(card.countries, code) ? card.countries[code] : card.bands
}

// No price above the last band of the list that applies: a country's bands
// cap it even when the default bands go higher.
export function priceForWeight(card: RateCard, grams: number, currency: string, country?: string | null): number | null {
  const band = bandsFor(card, country).find((b) => b.max_weight === null || grams <= b.max_weight)
  const price = band?.prices[currency.toLowerCase()]
  return typeof price === "number" ? price : null
}
