import { z } from "@medusajs/framework/zod"
import type { PrintTrailPluginOptions } from "../config"
import { PT_LIMITS } from "./input-limits"

// The plugin's business settings an admin can change on the settings page.
// A value saved there overrides the plugin options (medusa-config.ts), which
// stay the default. Credentials and deployment URLs are config only.
//
// Each overridden setting is one print_trail_state row, `setting:{key}`, so
// two admins saving different settings never lose each other's change and a
// reset replaces a row instead of removing a JSON key (service updates merge
// JSON objects).

export const SETTING_KEYS = [
  "orderNumberPrefix",
  "defaultShippingMethod",
  "confirmOn",
  "strictSkus",
  "stockSync.enabled",
  "reconcile.enabled",
  "reconcile.lookbackDays",
  "autoComplete",
  "notifications.shipment",
  "notifications.cancelTooLate",
  "notifications.adminEmail",
  "stockLocationIds",
] as const

export type SettingKey = (typeof SETTING_KEYS)[number]

export const isSettingKey = (key: unknown): key is SettingKey =>
  typeof key === "string" && (SETTING_KEYS as readonly string[]).includes(key)

export const SETTING_STATE_PREFIX = "setting:"
export const settingStateKey = (key: SettingKey) => `${SETTING_STATE_PREFIX}${key}`

// Who changed a setting and when. A reset keeps the row (overridden false),
// so it records who reset it. placed_since (confirmOn only): when a save or
// reset in the admin switched orders to being confirmed when placed; the
// sweep confirms the orders held for payment from before then (a switch in
// the plugin options records none).
export type SettingRecord = (
  | { overridden: true; value: unknown; changed_by: string | null; changed_at: string }
  | { overridden: false; changed_by: string | null; changed_at: string }
) & { placed_since?: string | null }

// What a save can ask the admin to confirm; a save names the ones confirmed.
export const CONFIRM_REASONS = ["prefix-may-repeat", "confirms-awaiting-payment"] as const
export type ConfirmReason = (typeof CONFIRM_REASONS)[number]

// When the admin switched confirmOn to order.placed, from its record; null
// with no switch recorded (or one that isn't a date).
export function confirmOnPlacedSince(records: Partial<Record<SettingKey, SettingRecord | null>>): Date | null {
  const at = records.confirmOn?.placed_since
  if (typeof at !== "string") return null
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? null : d
}

// Room for the display id (a 32-bit serial: 10 digits) and "-n" (a dash and
// up to 5 digits) within Print Trail's 255-character orderNumber.
export const MAX_PREFIX_LENGTH = PT_LIMITS.orderNumber - 10 - 6

// Letters, digits and - _ . / #: readable, and safe in URLs and emails. The
// Print Trail API sets no pattern for orderNumber; this is the plugin's.
export const PREFIX_PATTERN = /^[A-Za-z0-9._\-/#]*$/

export const LOOKBACK_DAYS = { min: 1, max: 90 } as const
export const MAX_ADMIN_EMAILS = 20
export const MAX_STOCK_LOCATIONS = 100
export const CONFIRM_ON = ["order.placed", "payment.captured"] as const

const template = z.union([z.literal(false), z.string().trim().min(1).max(255)])

const emails = z
  .array(z.string().trim().pipe(z.email({ message: "Enter valid email addresses" })))
  .max(MAX_ADMIN_EMAILS)
  // Repeats dropped whatever their case; the first spelling is kept.
  .transform((list) => [...new Map(list.map((e) => [e.toLowerCase(), e])).values()])

const locationIds = z
  .array(z.string().trim().min(1))
  .max(MAX_STOCK_LOCATIONS)
  .transform((list) => [...new Set(list)])

// One value schema per key, for the admin route and for reading a stored
// value back. Checks that need Print Trail or the database (a known
// shipping method, existing stock locations) are the workflow's.
export const SETTING_SCHEMAS = {
  orderNumberPrefix: z
    .string()
    .max(MAX_PREFIX_LENGTH, `The prefix can be at most ${MAX_PREFIX_LENGTH} characters`)
    .regex(PREFIX_PATTERN, "Use letters, digits and - _ . / # only, with no spaces"),
  defaultShippingMethod: z.string().trim().min(1).max(255),
  confirmOn: z.enum(CONFIRM_ON),
  strictSkus: z.boolean(),
  "stockSync.enabled": z.boolean(),
  "reconcile.enabled": z.boolean(),
  "reconcile.lookbackDays": z.number().int().min(LOOKBACK_DAYS.min).max(LOOKBACK_DAYS.max),
  autoComplete: z.boolean(),
  "notifications.shipment": template,
  "notifications.cancelTooLate": template,
  "notifications.adminEmail": emails,
  stockLocationIds: locationIds,
} satisfies Record<SettingKey, z.ZodType>

export type SettingValues = { [K in SettingKey]: z.output<(typeof SETTING_SCHEMAS)[K]> }

// The value a key has in these options.
export function configValue<K extends SettingKey>(o: PrintTrailPluginOptions, key: K): SettingValues[K] {
  const values: SettingValues = {
    orderNumberPrefix: o.orderNumberPrefix,
    defaultShippingMethod: o.defaultShippingMethod,
    confirmOn: o.confirmOn,
    strictSkus: o.strictSkus,
    "stockSync.enabled": o.stockSync.enabled,
    "reconcile.enabled": o.reconcile.enabled,
    "reconcile.lookbackDays": o.reconcile.lookbackDays,
    autoComplete: o.autoComplete,
    "notifications.shipment": o.notifications.shipment,
    "notifications.cancelTooLate": o.notifications.cancelTooLate,
    "notifications.adminEmail": o.notifications.adminEmail,
    stockLocationIds: o.stockLocationIds ?? [],
  }
  return values[key]
}

// These options with one key's value replaced; nested siblings are kept.
export function withValue<K extends SettingKey>(
  o: PrintTrailPluginOptions,
  key: K,
  value: SettingValues[K]
): PrintTrailPluginOptions {
  const v = value as never
  switch (key) {
    case "stockSync.enabled":
      return { ...o, stockSync: { ...o.stockSync, enabled: v } }
    case "reconcile.enabled":
      return { ...o, reconcile: { ...o.reconcile, enabled: v } }
    case "reconcile.lookbackDays":
      return { ...o, reconcile: { ...o.reconcile, lookbackDays: v } }
    case "notifications.shipment":
      return { ...o, notifications: { ...o.notifications, shipment: v } }
    case "notifications.cancelTooLate":
      return { ...o, notifications: { ...o.notifications, cancelTooLate: v } }
    case "notifications.adminEmail":
      return { ...o, notifications: { ...o.notifications, adminEmail: v } }
    case "stockLocationIds": {
      // An empty list is every location stocking the SKU, as unset is.
      const ids = value as string[]
      return { ...o, stockLocationIds: ids.length ? ids : undefined }
    }
    default:
      return { ...o, [key]: v }
  }
}

// Parses a stored value with its key's schema: null when it doesn't parse.
export function parseSettingValue<K extends SettingKey>(key: K, value: unknown): SettingValues[K] | null {
  const parsed = SETTING_SCHEMAS[key].safeParse(value)
  return parsed.success ? (parsed.data as SettingValues[K]) : null
}

// The effective options: each overridden key's stored value over the
// config. A stored value that no longer parses is ignored (config wins).
export function applyOverrides(
  config: PrintTrailPluginOptions,
  records: Partial<Record<SettingKey, SettingRecord | null>>,
  warn?: (message: string) => void
): PrintTrailPluginOptions {
  let out = config
  for (const key of SETTING_KEYS) {
    const record = records[key]
    if (!record?.overridden) continue
    const value = parseSettingValue(key, record.value)
    if (value === null) {
      warn?.(`Print Trail: ignored the stored ${key} setting, which isn't valid; using the plugin options`)
      continue
    }
    out = withValue(out, key, value)
  }
  return out
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")

// Order numbers already sent that a new prefix could produce again. A row
// numbered prefix + d (or + d-n) for an order whose display id isn't d
// means a later order d, or a later row of order d, would get that number,
// and Print Trail would replace that draft or refuse the order. A row
// numbered under the prefix for its own order is safe: display ids are
// unique and only increase. The prefix is compared ignoring case, which
// flags more numbers, never fewer.
export function reusedOrderNumbers(
  prefix: string,
  rows: { pt_order_number: string | null; display_id: number | string | null | undefined }[]
): string[] {
  const re = new RegExp(`^${escapeRegExp(prefix)}(\\d+)(?:-\\d+)?$`, "i")
  const out: string[] = []
  for (const row of rows) {
    const m = row.pt_order_number ? re.exec(row.pt_order_number) : null
    if (!m) continue
    if (row.display_id !== null && row.display_id !== undefined && String(row.display_id) === m[1]) continue
    out.push(row.pt_order_number!)
  }
  return out
}
