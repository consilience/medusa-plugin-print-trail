import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { PrintTrailPluginOptions } from "../../config"
import { PRINT_TRAIL_MODULE } from "../../modules/printTrail"
import type PrintTrailModuleService from "../../modules/printTrail/service"
import type { SettingKeyDto, SettingsView, SettingValueDto } from "../admin-types"
import { FALLBACK_METHODS } from "../rate-card"
import {
  applyOverrides,
  CONFIRM_ON,
  configValue,
  type ConfirmReason,
  LOOKBACK_DAYS,
  MAX_ADMIN_EMAILS,
  MAX_PREFIX_LENGTH,
  parseSettingValue,
  reusedOrderNumbers,
  SETTING_KEYS,
  type SettingKey,
  type SettingRecord,
  type SettingValues,
} from "../settings"
import { AWAITING_PAYMENT, awaitingPaymentRows, sweepWindow } from "../sweep"

// The settings page's editable settings: the view, and a save or reset.

export type SettingsStore = {
  getConfigOptions(): Promise<PrintTrailPluginOptions>
  readSettingRecords(): Promise<Partial<Record<SettingKey, SettingRecord>>>
  writeSettingRecords(records: Partial<Record<SettingKey, SettingRecord>>): Promise<void>
}

export type OrderNumberRow = { id: string; order_id: string; pt_order_number: string | null }

export type SettingsDeps = {
  store: SettingsStore
  // The shipping methods Print Trail lists, else (not connected, or not
  // reachable) the fallback codes.
  methods(): Promise<{ methods: { code: string; name: string }[]; source: "print-trail" | "fallback" }>
  stockLocations(): Promise<{ id: string; name: string | null }[]>
  users(ids: string[]): Promise<{ id: string; email: string | null; name: string | null }[]>
  // Up to `take` rows whose number starts with `prefix` in any case, with
  // ids after `after` (null: from the first), by id.
  orderNumberPage(prefix: string, after: string | null, take: number): Promise<OrderNumberRow[]>
  displayIds(orderIds: string[]): Promise<Map<string, number | string | null>>
  // How many rows held for a payment capture the sweep would send under
  // confirmOn order.placed, with this look-back (awaitingPaymentRows).
  awaitingPaymentCount(lookbackDays: number): Promise<number>
  logger?: { info(message: string): void; warn?(message: string): void }
  now?: () => Date
}

export type SaveSettingsInput = {
  values?: Partial<SettingValues>
  reset?: SettingKey[]
  actor_id?: string | null
  // The confirms the admin gave, each for the question it was shown.
  confirm?: ConfirmReason[]
}

// partial: the scan stopped at its cap before reading every order sent, so
// numbers may be empty and the prefix still unsafe.
export type SaveConfirmation =
  | { status: "needs-confirmation"; reason: "prefix-may-repeat"; numbers: string[]; partial: boolean }
  | { status: "needs-confirmation"; reason: "confirms-awaiting-payment"; count: number }

export type SaveOutcome =
  | { status: "saved"; keys: SettingKey[]; warnings: string[] }
  | SaveConfirmation
  | { status: "invalid"; issues: { key: SettingKey; message: string }[] }

const REUSE_PAGE = 500
const REUSE_EXAMPLES = 5
// At most 10,000 rows: a short or empty prefix matches every order sent.
export const REUSE_MAX_PAGES = 20

// Order numbers already sent that this prefix could produce again (up to
// five examples), from the rows whose number starts with it, in any case,
// reading at most REUSE_MAX_PAGES pages: partial when it stopped there.
export async function findReusedOrderNumbers(
  deps: SettingsDeps,
  prefix: string
): Promise<{ numbers: string[]; partial: boolean }> {
  const found: string[] = []
  let after: string | null = null
  for (let pages = 0; ; pages++) {
    if (pages === REUSE_MAX_PAGES) return { numbers: found, partial: true }
    const page = await deps.orderNumberPage(prefix, after, REUSE_PAGE)
    if (!page.length) break
    const digits = page.filter((r) => r.pt_order_number && /^\d+(?:-\d+)?$/.test(r.pt_order_number.slice(prefix.length)))
    if (digits.length) {
      const ids = await deps.displayIds([...new Set(digits.map((r) => r.order_id))])
      found.push(...reusedOrderNumbers(prefix, digits.map((r) => ({ pt_order_number: r.pt_order_number, display_id: ids.get(r.order_id) }))))
      if (found.length >= REUSE_EXAMPLES) break
    }
    if (page.length < REUSE_PAGE) break
    after = page[page.length - 1].id
  }
  return { numbers: found.slice(0, REUSE_EXAMPLES), partial: false }
}

// The options the stored settings give now, read afresh (never a process's
// cached copy), and the keys whose stored value no longer parses, so the
// plugin options' value applies.
async function current(store: SettingsStore) {
  const [config, records] = await Promise.all([store.getConfigOptions(), store.readSettingRecords()])
  const effective = applyOverrides(config, records, () => {})
  const ignored = SETTING_KEYS.filter((key) => {
    const r = records[key]
    return !!r?.overridden && parseSettingValue(key, r.value) === null
  })
  return { config, records, effective, ignored }
}

// A key's value once this save lands: its new value, or after a reset the
// plugin options' value; undefined when the save leaves it alone.
function incoming<K extends SettingKey>(
  key: K,
  values: Partial<SettingValues>,
  resetKeys: SettingKey[],
  config: PrintTrailPluginOptions
): SettingValues[K] | undefined {
  if (values[key] !== undefined) return values[key] as SettingValues[K]
  return resetKeys.includes(key) ? (configValue(config, key) as SettingValues[K]) : undefined
}

// A save (values) and resets (reset), checked first: the stock locations
// must exist, and the shipping method must be one Print Trail offers (while
// it can't be reached, a method other than the one in force is saved with a
// warning). Nothing is saved, unless that question is in confirm, when the
// prefix coming into force (saved, or the plugin options' after a reset)
// could repeat an order number already sent (or the scan couldn't read every
// order), or when switching to confirming when placed would confirm orders
// waiting for payment. Every written key records who and when; a switch of
// confirmOn to order.placed also records when (placed_since), which the
// sweep's confirm of the orders held for payment needs.
export async function saveSettings(deps: SettingsDeps, input: SaveSettingsInput): Promise<SaveOutcome> {
  const values = input.values ?? {}
  const setKeys = SETTING_KEYS.filter((k) => values[k] !== undefined)
  const resetKeys = SETTING_KEYS.filter((k) => (input.reset ?? []).includes(k) && !setKeys.includes(k))
  const issues: { key: SettingKey; message: string }[] = []
  const warnings: string[] = []
  const { config, effective, records: stored } = await current(deps.store)
  const confirmed = new Set(input.confirm ?? [])

  const method = values.defaultShippingMethod
  if (method !== undefined) {
    const { methods, source } = await deps.methods()
    if (source === "print-trail") {
      if (!methods.some((m) => m.code === method)) {
        issues.push({
          key: "defaultShippingMethod",
          message: `Print Trail doesn't offer the shipping method "${method}" (offered: ${methods.map((m) => m.code).join(", ")})`,
        })
      }
    } else if (method !== effective.defaultShippingMethod && method !== config.defaultShippingMethod) {
      warnings.push(
        `Print Trail couldn't be reached, so the shipping method "${method}" wasn't checked; Print Trail refuses to confirm an order with a code it doesn't offer`
      )
    }
  }
  const locations = values.stockLocationIds
  if (locations?.length) {
    const known = new Set((await deps.stockLocations()).map((l) => l.id))
    const missing = locations.filter((id) => !known.has(id))
    if (missing.length) issues.push({ key: "stockLocationIds", message: `No stock location ${missing.join(", ")}` })
  }
  if (issues.length) return { status: "invalid", issues }

  const prefix = incoming("orderNumberPrefix", values, resetKeys, config)
  if (prefix !== undefined && prefix !== effective.orderNumberPrefix && !confirmed.has("prefix-may-repeat")) {
    const { numbers, partial } = await findReusedOrderNumbers(deps, prefix)
    if (numbers.length || partial) return { status: "needs-confirmation", reason: "prefix-may-repeat", numbers, partial }
  }
  const confirmOn = incoming("confirmOn", values, resetKeys, config)
  const switchesToPlaced = confirmOn === "order.placed" && effective.confirmOn !== "order.placed"
  if (switchesToPlaced && !confirmed.has("confirms-awaiting-payment")) {
    const lookback = incoming("reconcile.lookbackDays", values, resetKeys, config) ?? effective.reconcile.lookbackDays
    const count = await deps.awaitingPaymentCount(lookback)
    if (count > 0) return { status: "needs-confirmation", reason: "confirms-awaiting-payment", count }
  }

  const changed_at = (deps.now ? deps.now() : new Date()).toISOString()
  const changed_by = input.actor_id ?? null
  const records: Partial<Record<SettingKey, SettingRecord>> = {}
  for (const key of setKeys) records[key] = { overridden: true, value: values[key], changed_by, changed_at }
  for (const key of resetKeys) records[key] = { overridden: false, changed_by, changed_at }
  // The switch's time, kept while orders stay confirmed when placed; any
  // other confirmOn drops it.
  if (records.confirmOn && confirmOn === "order.placed") {
    records.confirmOn.placed_since = switchesToPlaced ? changed_at : (stored.confirmOn?.placed_since ?? null)
  }
  const keys = [...setKeys, ...resetKeys]
  if (keys.length) {
    await deps.store.writeSettingRecords(records)
    deps.logger?.info(
      `Print Trail: settings changed in the admin${changed_by ? ` by ${changed_by}` : ""}: ${[
        ...setKeys,
        ...resetKeys.map((k) => `${k} (reset)`),
      ].join(", ")}`
    )
    for (const w of warnings) deps.logger?.warn?.(`Print Trail: ${w}`)
  }
  return { status: "saved", keys, warnings }
}

// Each value as the stored settings give it now. A stored value that no
// longer parses shows as ignored, with the plugin options' value in force.
export async function settingsView(deps: SettingsDeps): Promise<SettingsView> {
  const [{ config, records, effective, ignored }, methods, stockLocations] = await Promise.all([
    current(deps.store),
    deps.methods(),
    deps.stockLocations(),
  ])
  const ids = [...new Set(Object.values(records).flatMap((r) => (r?.changed_by ? [r.changed_by] : [])))]
  const users = new Map((ids.length ? await deps.users(ids) : []).map((u) => [u.id, u]))
  return {
    settings: SETTING_KEYS.map((key) => {
      const record = records[key]
      const by = record?.changed_by ?? null
      return {
        key: key as SettingKeyDto,
        value: configValue(effective, key) as SettingValueDto,
        config: configValue(config, key) as SettingValueDto,
        source: ignored.includes(key) ? "ignored" : record?.overridden ? "admin" : "config",
        changed_at: record?.changed_at ?? null,
        changed_by: by ? (users.get(by) ?? { id: by, email: null, name: null }) : null,
      }
    }),
    choices: {
      shippingMethods: methods.methods,
      shippingMethodsSource: methods.source,
      stockLocations,
      confirmOn: [...CONFIRM_ON],
    },
    limits: { prefixMaxLength: MAX_PREFIX_LENGTH, lookbackDays: { ...LOOKBACK_DAYS }, adminEmails: MAX_ADMIN_EMAILS },
  }
}

// An ILIKE pattern for the prefix taken literally: its wildcards and the
// escape character escaped.
const likePrefix = (s: string) => `${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

export async function buildSettingsDeps(container: MedusaContainer): Promise<SettingsDeps> {
  const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const fallback = () => ({ methods: FALLBACK_METHODS.map((code) => ({ code, name: code })), source: "fallback" as const })
  return {
    store: service,
    logger,
    async methods() {
      if (!(await service.isConnected())) return fallback()
      try {
        const list = await (await service.getStatusClient()).listShippingMethods()
        const methods = (Array.isArray(list) ? list : []).flatMap((m) => (m?.code ? [{ code: m.code, name: m.name ?? m.code }] : []))
        return methods.length ? { methods, source: "print-trail" as const } : fallback()
      } catch {
        return fallback()
      }
    },
    async stockLocations() {
      const { data } = await query.graph({ entity: "stock_location", fields: ["id", "name"] })
      return (data as { id: string; name?: string | null }[]).map((l) => ({ id: l.id, name: l.name ?? null }))
    },
    async users(ids) {
      const { data } = await query.graph({ entity: "user", fields: ["id", "email", "first_name", "last_name"], filters: { id: ids } })
      return (data as { id: string; email?: string | null; first_name?: string | null; last_name?: string | null }[]).map((u) => ({
        id: u.id,
        email: u.email ?? null,
        name: [u.first_name, u.last_name].filter(Boolean).join(" ") || null,
      }))
    },
    async orderNumberPage(prefix, after, take) {
      const filters: Record<string, unknown> = { pt_order_number: { $ilike: likePrefix(prefix) } }
      if (after !== null) filters.id = { $gt: after }
      const rows = await service.listPrintTrailOrders(filters, {
        select: ["id", "order_id", "pt_order_number"],
        take,
        order: { id: "ASC" },
      })
      return rows as OrderNumberRow[]
    },
    async displayIds(orderIds) {
      const { data } = await query.graph({ entity: "order", fields: ["id", "display_id"], filters: { id: orderIds }, withDeleted: true })
      return new Map((data as { id: string; display_id?: number | null }[]).map((o) => [o.id, o.display_id ?? null]))
    },
    async awaitingPaymentCount(lookbackDays) {
      const now = new Date()
      const rows = await service.listPrintTrailOrders({
        block_reason: AWAITING_PAYMENT,
        confirmed_at: null,
        created_at: { $gte: sweepWindow(now, lookbackDays).from },
      })
      if (!rows.length) return 0
      const { data: orders } = await query.graph({
        entity: "order",
        fields: ["id", "created_at"],
        filters: { id: [...new Set(rows.map((r) => r.order_id))] },
      })
      // Every order placed until now: the switch would be made now.
      return awaitingPaymentRows(rows, orders as { id: string; created_at: Date }[], now, lookbackDays, new Date(now.getTime() + 1)).length
    },
  }
}
