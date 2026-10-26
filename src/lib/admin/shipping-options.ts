import type { CreateShippingOptionsWorkflowInput } from "@medusajs/medusa/core-flows"
import type { PrintTrailClient } from "../../modules/printTrail/client/client"
import type { RateCardDto, ShippingOptionView, ValidationIssue } from "../admin-types"
import { PRINT_TRAIL_PROVIDER_ID } from "../lines"
import { FALLBACK_METHODS, rateCardSchema, type RateCard } from "../rate-card"

// The Print Trail shipping page's rules, and the guard on Medusa's own
// shipping-option routes. Prices are major units, kept as entered.

export type RateCardBody = {
  name: string
  service_zone_id: string
  shipping_profile_id: string
  rate_card: unknown
}

export async function knownMethods(
  client: Pick<PrintTrailClient, "listShippingMethods"> | null
): Promise<{ codes: string[]; source: "print-trail" | "fallback" }> {
  if (client) {
    try {
      const list = await client.listShippingMethods()
      const codes = (Array.isArray(list) ? list : []).flatMap((m) => (m?.code ? [m.code] : []))
      if (codes.length) return { codes, source: "print-trail" }
    } catch {
      // Unreachable: the four codes Print Trail accepts.
    }
  }
  return { codes: [...FALLBACK_METHODS], source: "fallback" }
}

export function validateRateCard(
  card: unknown,
  methods: string[]
): { ok: true; card: RateCard } | { ok: false; issues: ValidationIssue[] } {
  const allowed = methods.length ? methods : [...FALLBACK_METHODS]
  // Zod skips the band checks once the method fails, so check the bands
  // with the card's own method allowed and report the method separately:
  // every issue at once.
  const method = (card as { method?: unknown } | null)?.method
  const unknownMethod = typeof method === "string" && method !== "" && !allowed.includes(method)
  const parsed = rateCardSchema(unknownMethod ? [...allowed, method as string] : allowed).safeParse(card)
  const issues: ValidationIssue[] = unknownMethod
    ? [{ path: "method", message: `Print Trail doesn't offer the shipping method "${method}"` }]
    : []
  if (!parsed.success) {
    issues.push(...parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })))
  }
  if (issues.length || !parsed.success) return { ok: false, issues }
  return { ok: true, card: parsed.data }
}

// Medusa's own create form sends the chosen fulfilment option ({ id, name,
// method }) as data; a rate card has bands, a currency or countries (Medusa
// merges data, so countries alone would land in the stored card unchecked).
export function looksLikeRateCard(data: unknown): boolean {
  return (
    !!data && typeof data === "object" && !Array.isArray(data) && ("bands" in data || "currency_code" in data || "countries" in data)
  )
}

export function rateCardData(card: RateCard): Record<string, unknown> {
  return { id: card.method, ...card }
}

// The data that replaces a stored card. Medusa merges a shipping option's
// data on update (nested objects too; arrays are replaced), so a country
// left out of the new card would survive: write null over each one dropped,
// or over the whole map when the new card has none. The schema reads null
// as not listed.
export function updateData(stored: Record<string, unknown> | null | undefined, card: RateCard): Record<string, unknown> {
  const data = rateCardData(card)
  const old = stored?.countries
  if (!old || typeof old !== "object" || Array.isArray(old)) return data
  if (!card.countries) return { ...data, countries: null }
  const dropped = Object.keys(old).filter((code) => !(code in card.countries!))
  return dropped.length ? { ...data, countries: { ...card.countries, ...Object.fromEntries(dropped.map((c) => [c, null])) } } : data
}

export function createInput(
  body: Omit<RateCardBody, "rate_card"> & { rate_card?: unknown },
  card: RateCard
): CreateShippingOptionsWorkflowInput[number] {
  return {
    name: body.name,
    service_zone_id: body.service_zone_id,
    shipping_profile_id: body.shipping_profile_id,
    provider_id: PRINT_TRAIL_PROVIDER_ID,
    // No prices: the workflow's calculated-option input has none (only the
    // core REST validator asks for them).
    price_type: "calculated",
    type: { label: body.name, description: "Print Trail", code: card.method },
    data: rateCardData(card),
    // As Medusa's own form: a store option, not a return.
    rules: [
      { attribute: "is_return", operator: "eq", value: "false" },
      { attribute: "enabled_in_store", operator: "eq", value: "true" },
    ],
  }
}

type GraphOption = {
  id: string
  name: string
  price_type?: string | null
  data?: Record<string, unknown> | null
  service_zone?: { id: string; name: string; fulfillment_set?: { name?: string | null } | null } | null
  shipping_profile?: { id: string; name: string } | null
}

const rawBands = (bands: unknown): RateCardDto["bands"] =>
  (Array.isArray(bands) ? (bands as { max_weight?: unknown; prices?: unknown }[]) : []).map((b) => ({
    max_weight: typeof b?.max_weight === "number" ? b.max_weight : null,
    prices: b?.prices && typeof b.prices === "object" ? (b.prices as Record<string, number>) : {},
  }))

// An invalid card as it is stored, so the page can still show it.
const rawCard = (data: Record<string, unknown>): RateCardDto | null => {
  if (!Array.isArray(data.bands)) return null
  const card: RateCardDto = {
    method: typeof data.method === "string" ? data.method : "",
    currency_code: typeof data.currency_code === "string" ? data.currency_code : "",
    bands: rawBands(data.bands),
  }
  if (data.countries && typeof data.countries === "object" && !Array.isArray(data.countries)) {
    card.countries = Object.fromEntries(
      Object.entries(data.countries).flatMap(([code, bands]) => (bands === null ? [] : [[code, rawBands(bands)]]))
    )
  }
  return card
}

export function toShippingOptionView(option: unknown, methods: string[]): ShippingOptionView {
  const o = option as GraphOption
  const data = o.data ?? null
  let rate_card: RateCardDto | null = null
  let card_issue: ShippingOptionView["card_issue"] = "missing"
  if (data && looksLikeRateCard(data)) {
    const valid = validateRateCard(data, methods)
    if (valid.ok) {
      const { method, currency_code, bands, countries } = valid.card
      rate_card = { method, currency_code, bands, ...(countries ? { countries } : {}) }
      card_issue = null
    } else {
      rate_card = rawCard(data)
      card_issue = "invalid"
    }
  }
  return {
    id: o.id,
    name: o.name,
    service_zone: o.service_zone
      ? { id: o.service_zone.id, name: o.service_zone.name, location: o.service_zone.fulfillment_set?.name ?? null }
      : null,
    shipping_profile: o.shipping_profile ? { id: o.shipping_profile.id, name: o.shipping_profile.name } : null,
    price_type: o.price_type ?? "calculated",
    rate_card,
    card_issue,
  }
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])

// MikroORM's Utils.isObject and Utils.isPlainObject (@mikro-orm/core 6.6,
// utils/Utils.js), copied rather than imported: the plugin doesn't depend on
// MikroORM. An object with its own `constructor` key is not plain, so
// MikroORM replaces it instead of merging it.
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false
  const ctor = (v as { constructor?: unknown }).constructor
  if (typeof ctor === "function") {
    const proto = (ctor as { prototype?: object }).prototype
    if (proto && (Object.prototype.hasOwnProperty.call(proto, "isPrototypeOf") || Object.getPrototypeOf(proto) === null)) return true
  }
  return Object.getPrototypeOf(v) === null
}

// Utils._merge, as Utils.merge calls it.
function mergeInto(target: Record<string, unknown>, source: unknown): Record<string, unknown> {
  if (!isObject(target) || !isPlainObject(source)) return target
  for (const [key, value] of Object.entries(source)) {
    if (UNSAFE_KEYS.has(key)) continue
    if (isPlainObject(value)) {
      if (!isObject(target[key])) {
        target[key] = structuredClone(value)
        continue
      }
      mergeInto(target[key] as Record<string, unknown>, value)
    } else {
      target[key] = value
    }
  }
  return target
}

// The data Medusa will store when `body` updates an option holding `stored`:
// EntityAssigner.assignProperty with mergeObjectProperties merges only when
// both are Utils.isPlainObject (Utils.merge({}, stored, body)) and otherwise
// replaces the whole column with the body. Inside, plain objects merge key by
// key; arrays, null, scalars and non-plain objects replace. Neither argument
// is changed. The unit tests check it against MikroORM itself.
export function mergeData(stored: Record<string, unknown> | null | undefined, body: Record<string, unknown>): Record<string, unknown> {
  if (!isPlainObject(stored) || !isPlainObject(body)) return body
  return mergeInto(mergeInto({}, structuredClone(stored)), body)
}

// Where `data` holds a key MikroORM treats specially, as a path, or null.
function unsafeKeyPath(value: unknown, path: string[] = []): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = unsafeKeyPath(value[i], [...path, String(i)])
      if (found) return found
    }
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) return [...path, key].join(".")
      const found = unsafeKeyPath(child, [...path, key])
      if (found) return found
    }
  }
  return null
}

const COUNTRIES_ALONE =
  "countries needs a rate card to join: send method, currency_code and bands with it, or update an option that has a card"

// For Medusa's own /admin/shipping-options routes: a Print Trail option's
// card-shaped data must be a valid card. On update (`stored` given) the card
// checked is the one Medusa will store, the body merged over the stored data,
// so a partial body can't leave the stored card invalid. Anything else passes.
export function guardShippingOptionData(input: {
  providerId: string | null
  data: unknown
  stored?: Record<string, unknown> | null
  methods: string[]
}): { ok: true } | { ok: false; issues: ValidationIssue[] } {
  if (input.providerId !== PRINT_TRAIL_PROVIDER_ID) return { ok: true }
  // MikroORM replaces, rather than merges, an object with its own
  // `constructor` key, and skips these keys when it does merge: a body using
  // them would store something other than the merge checked below. They
  // never belong in a rate card, so they are refused anywhere in it.
  const unsafe = unsafeKeyPath(input.data)
  if (unsafe) {
    const key = unsafe.split(".").pop()
    return { ok: false, issues: [{ path: unsafe, message: `"${key}" isn't allowed in a rate card` }] }
  }
  const merged = input.stored !== undefined && isPlainObject(input.data) ? mergeData(input.stored, input.data) : input.data
  if (!looksLikeRateCard(merged)) return { ok: true }
  const card = merged as Record<string, unknown>
  if (!("bands" in card) && !("currency_code" in card)) {
    return { ok: false, issues: [{ path: "countries", message: COUNTRIES_ALONE }] }
  }
  const valid = validateRateCard(merged, input.methods)
  const issues = valid.ok ? [] : [...valid.issues]
  // Medusa stores the body as sent, and its merge would keep an `FR` beside a
  // stored `fr`; the plugin's routes lower-case codes, these can't, so they
  // refuse them. A null (a removal) may name any case.
  // A null removes the stored key it names exactly (an old upper-case one
  // too); one that names none would be a 200 that removes nothing, so it is
  // refused rather than guessed at by case.
  const sent = isPlainObject(input.data) ? input.data.countries : undefined
  const storedCountries = isPlainObject(input.stored?.countries) ? input.stored.countries : {}
  if (isPlainObject(sent)) {
    for (const [code, bands] of Object.entries(sent)) {
      if (bands === null && !Object.prototype.hasOwnProperty.call(storedCountries, code)) {
        issues.push({
          path: `countries.${code}`,
          message: `This card has no country "${code}" to remove (country codes are matched exactly)`,
        })
      } else if (bands !== null && code !== code.toLowerCase()) {
        issues.push({
          path: `countries.${code}`,
          message: `Use a lower-case country code here ("${code.toLowerCase()}"): Medusa stores the card as sent`,
        })
      }
    }
  }
  return issues.length ? { ok: false, issues } : { ok: true }
}
