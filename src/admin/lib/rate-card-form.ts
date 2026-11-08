import type { RateCardDto, ShippingOptionView } from "../../lib/admin-types"

// The rate-card editor's form state and its conversion. Prices are major
// units as entered (3.95 is £3.95): never multiplied or divided.

export type RateCardForm = {
  name: string
  service_zone_id: string
  shipping_profile_id: string
  method: string
  currency_code: string
  // other_prices: the band's prices in other currencies, which the editor
  // doesn't show; carried through an edit untouched.
  bands: { max_weight: string; price: string; other_prices?: Record<string, number> }[]
  // The per-country bands, which the editor shows but doesn't edit; carried
  // through an edit untouched, or saving the default bands would drop them.
  countries?: RateCardDto["countries"]
  // Free-delivery thresholds as entered, by lower-case currency code; an
  // empty one is no threshold in that currency.
  free_over?: Record<string, string>
}

export type RateCardFormResult =
  | { ok: true; body: { name: string; service_zone_id: string; shipping_profile_id: string; rate_card: RateCardDto } }
  // Errors by field path, each an i18n key.
  | { ok: false; errors: Record<string, string> }

export const emptyForm = (): RateCardForm => ({
  name: "",
  service_zone_id: "",
  shipping_profile_id: "",
  method: "",
  currency_code: "",
  bands: [{ max_weight: "", price: "" }],
})

// "3,95" and "3.95" both read as 3.95.
const parseNumber = (s: string): number | null => {
  const v = s.trim().replace(",", ".")
  return /^\d+(\.\d+)?$/.test(v) ? Number(v) : null
}

// "1,250" could be 1.25 or 1250: a comma before exactly three digits is
// refused rather than guessed.
const ambiguousComma = (s: string) => /^\d+,\d{3}$/.test(s.trim())

export function formToRateCard(f: RateCardForm): RateCardFormResult {
  const errors: Record<string, string> = {}
  if (!f.name.trim()) errors.name = "shipping.errors.required"
  if (!f.service_zone_id) errors.service_zone_id = "shipping.errors.required"
  if (!f.shipping_profile_id) errors.shipping_profile_id = "shipping.errors.required"
  if (!f.method) errors.method = "shipping.errors.required"
  const currency = f.currency_code.trim().toLowerCase()
  if (!/^[a-z]{3}$/.test(currency)) errors.currency_code = "shipping.errors.currency"
  if (!f.bands.length) errors.bands = "shipping.errors.noBands"

  let previous = 0
  const bands = f.bands.map((b, i) => {
    let max_weight: number | null = null
    if (!b.max_weight.trim()) {
      if (i !== f.bands.length - 1) errors[`bands.${i}.max_weight`] = "shipping.errors.openBandNotLast"
    } else if (ambiguousComma(b.max_weight)) {
      errors[`bands.${i}.max_weight`] = "shipping.errors.ambiguousComma"
    } else {
      const w = parseNumber(b.max_weight)
      if (w === null || w <= 0) errors[`bands.${i}.max_weight`] = "shipping.errors.weight"
      else if (w <= previous) errors[`bands.${i}.max_weight`] = "shipping.errors.ascending"
      else previous = w
      max_weight = w
    }
    const price = ambiguousComma(b.price) ? null : parseNumber(b.price)
    if (ambiguousComma(b.price)) errors[`bands.${i}.price`] = "shipping.errors.ambiguousComma"
    else if (price === null) errors[`bands.${i}.price`] = "shipping.errors.price"
    const others = Object.fromEntries(Object.entries(b.other_prices ?? {}).filter(([c]) => c !== currency))
    return { max_weight, prices: { ...others, [currency]: price ?? 0 } }
  })

  // Thresholds, read as band prices are; an empty one is left out.
  const freeOver: Record<string, number> = {}
  for (const [code, entered] of Object.entries(f.free_over ?? {})) {
    if (!entered.trim()) continue
    const amount = ambiguousComma(entered) ? null : parseNumber(entered)
    if (ambiguousComma(entered)) errors[`free_over.${code}`] = "shipping.errors.ambiguousComma"
    else if (amount === null) errors[`free_over.${code}`] = "shipping.errors.freeOver"
    else freeOver[code] = amount
  }

  // Changing the card's currency needs every country's bands priced in it.
  if (/^[a-z]{3}$/.test(currency) && Object.values(f.countries ?? {}).some((list) => list.some((b) => typeof b.prices?.[currency] !== "number"))) {
    errors.countries = "shipping.errors.countriesCurrency"
  }

  if (Object.keys(errors).length) return { ok: false, errors }
  return {
    ok: true,
    body: {
      name: f.name.trim(),
      service_zone_id: f.service_zone_id,
      shipping_profile_id: f.shipping_profile_id,
      rate_card: {
        method: f.method,
        currency_code: currency,
        bands,
        ...(f.countries ? { countries: f.countries } : {}),
        ...(Object.keys(freeOver).length ? { free_over: freeOver } : {}),
      },
    },
  }
}

// A stored number as the form's parser reads it: plain decimal digits, never
// an exponent (String(1e-7) is "1e-7", which parseNumber refuses).
export function decimal(n: number): string {
  return n.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 })
}

export function rateCardToForm(option: ShippingOptionView): RateCardForm {
  const card = option.rate_card
  const currency = card?.currency_code ?? ""
  return {
    name: option.name,
    service_zone_id: option.service_zone?.id ?? "",
    shipping_profile_id: option.shipping_profile?.id ?? "",
    method: card?.method ?? "",
    currency_code: currency.toUpperCase(),
    bands: card?.bands.length
      ? card.bands.map((b) => ({
          max_weight: b.max_weight === null ? "" : decimal(b.max_weight),
          price: b.prices[currency] === undefined ? "" : decimal(b.prices[currency]),
          other_prices: Object.fromEntries(Object.entries(b.prices).filter(([c]) => c !== currency)),
        }))
      : emptyForm().bands,
    ...(card?.countries ? { countries: card.countries } : {}),
    ...(card?.free_over ? { free_over: Object.fromEntries(Object.entries(card.free_over).map(([c, v]) => [c, decimal(v)])) } : {}),
  }
}

// The currencies the editor offers a threshold in: the card's own, those
// its default and per-country bands price in, and any that already has one,
// card's first.
export function freeOverCurrencies(f: RateCardForm): string[] {
  const own = f.currency_code.trim().toLowerCase()
  const codes = new Set<string>(/^[a-z]{3}$/.test(own) ? [own] : [])
  for (const band of f.bands) for (const code of Object.keys(band.other_prices ?? {})) codes.add(code)
  for (const bands of Object.values(f.countries ?? {})) for (const band of bands) for (const code of Object.keys(band.prices ?? {})) codes.add(code)
  for (const code of Object.keys(f.free_over ?? {})) codes.add(code)
  return [...codes]
}

// The thresholds for the card summary, card's currency first.
export function describeFreeOver(card: RateCardDto): { currency: string; amount: number }[] {
  return Object.entries(card.free_over ?? {})
    .sort(([a], [b]) => (a === card.currency_code ? -1 : b === card.currency_code ? 1 : a.localeCompare(b)))
    .map(([currency, amount]) => ({ currency, amount }))
}

// "France (FR)": the browser's own country names, so the admin bundle
// carries no list.
export function countryLabel(code: string, locale?: string): string {
  const upper = code.toUpperCase()
  try {
    const name = new Intl.DisplayNames(locale ? [locale] : undefined, { type: "region" }).of(upper)
    return name && name !== upper ? `${name} (${upper})` : upper
  } catch {
    return upper
  }
}

// The drawer can remove a country (the update route then writes null over
// it), which is also how a country the card can't accept is repaired.
export function removeCountry(f: RateCardForm, code: string): RateCardForm {
  if (!f.countries) return f
  const { [code]: _removed, ...rest } = f.countries
  return { ...f, countries: rest }
}

// Each country's bands, for the read-only list.
export function describeCountries(card: RateCardDto): { code: string; bands: ReturnType<typeof describeBands> }[] {
  return Object.entries(card.countries ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, bands]) => ({ code, bands: describeBands({ ...card, bands }) }))
}

export function describeBands(card: RateCardDto): { upTo: number | null; from: number; price: number }[] {
  let from = 0
  return card.bands.map((b) => {
    const row = { from, upTo: b.max_weight, price: b.prices[card.currency_code] ?? 0 }
    if (b.max_weight !== null) from = b.max_weight
    return row
  })
}
