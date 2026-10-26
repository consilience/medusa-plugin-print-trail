import type { Context } from "@medusajs/framework/types"
import { InjectTransactionManager, MedusaContext, MedusaError, MedusaService } from "@medusajs/framework/utils"
import {
  isConnected,
  resolvePluginOptions,
  type PrintTrailPluginOptions,
} from "../../config"
import { createApiVersionTracker } from "../../lib/api-version"
import { createAuthTracker } from "../../lib/auth-state"
import { LOCKING_CHECK_STATE_KEY, type LockingCheck } from "../../lib/locking-check"
import { PRE_ORDER_SEEN_PREFIX } from "../../lib/pre-order"
import { normaliseSku } from "../../lib/sku"
import type { SkuCheck, SkuCheckStatus } from "../../lib/sku-check"
import { createEachUnlessExists } from "../../lib/state-queue"
import { checkColumns, type CheckColumns, type CheckSource, type VariantCheckRow } from "../../lib/variant-checks"
import { PrintTrailClient, STATUS_CLIENT_TUNING, type RateLimitGate } from "./client/client"
import { PROBLEM_TYPES } from "./client/errors"
import PrintTrailOrder from "./models/print-trail-order"
import PrintTrailOrderEvent from "./models/print-trail-order-event"
import PrintTrailState from "./models/print-trail-state"
import PrintTrailVariant from "./models/print-trail-variant"

export { AUTH_FAILED_STATE_KEY, CHANNEL_INACTIVE_STATE_KEY, type AuthFailedState } from "../../lib/auth-state"

type Logger = { warn(message: string): void }

const SEEN_CHUNK = 500
const VARIANT_ROW_CHUNK = 500

const chunks = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

type VariantRowInput = { variant_id: string; product_id: string } & CheckColumns

export type CheckStatusUpdate = {
  id: string
  // The row's check as it was read: written only while it still is.
  expect: { sku: string | null; status: string }
  // null clears the check, so the SKU check runs again.
  status: SkuCheckStatus | null
  at: Date
}

// CRUD only, plus the plugin options and the API client built from them.
// Business logic lives in workflows.
class PrintTrailModuleService extends MedusaService({
  PrintTrailOrder,
  PrintTrailOrderEvent,
  PrintTrailState,
  PrintTrailVariant,
}) {
  protected readonly options_: PrintTrailPluginOptions
  private client_?: PrintTrailClient
  private statusClient_?: PrintTrailClient
  // One Retry-After pause for both clients of this process.
  private readonly rateLimitGate_: RateLimitGate = { until: 0 }
  protected readonly lockingCheck_: LockingCheck | null
  protected readonly logger_: Logger | null
  // Access refusals this process has heard (refusalWatch).
  private accessRefusals_ = 0
  // Records auth_failed and channel_inactive from every request either client makes.
  private readonly onStatus_: (status: number, path: string, problemType?: string | null) => void
  // Records the Print Trail API version either client hears (display only).
  private readonly onApiVersion_: (version: string, path: string) => void

  constructor(container: Record<string, unknown>, options?: Partial<PrintTrailPluginOptions>) {
    super(...arguments)
    this.options_ = resolvePluginOptions(options)
    // Registered by the check-locking loader (absent in some test runners).
    let check: LockingCheck | null = null
    try {
      check = (container.printTrailLockingCheck as LockingCheck | undefined) ?? null
    } catch {
      check = null
    }
    this.lockingCheck_ = check
    let logger: Logger | null = null
    try {
      logger = (container.logger as Logger | undefined) ?? null
    } catch {
      logger = null
    }
    this.logger_ = logger
    const track = createAuthTracker(this, logger)
    this.onStatus_ = (status, path, problemType) => {
      if (status === 401 || (status === 403 && problemType === PROBLEM_TYPES.channelInactive)) this.accessRefusals_++
      track(status, path, problemType)
    }
    this.onApiVersion_ = createApiVersionTracker(this, logger)
  }

  async accessRefusalCount(): Promise<number> {
    return this.accessRefusals_
  }

  async getLockingCheck(): Promise<LockingCheck | null> {
    return this.lockingCheck_
  }

  // Writes the startup locking check to print_trail_state when it changed
  // (for the admin's settings page). Run by the sweep.
  async recordLockingCheck(): Promise<void> {
    if (!this.lockingCheck_) return
    const stored = await this.getState<LockingCheck>(LOCKING_CHECK_STATE_KEY)
    if (JSON.stringify(stored) !== JSON.stringify(this.lockingCheck_)) {
      await this.setState(LOCKING_CHECK_STATE_KEY, this.lockingCheck_)
    }
  }

  async getOptions(): Promise<PrintTrailPluginOptions> {
    return this.options_
  }

  async isConnected(): Promise<boolean> {
    return isConnected(this.options_)
  }

  async getClient(): Promise<PrintTrailClient> {
    this.assertConnected()
    this.client_ ??= new PrintTrailClient({
      baseUrl: this.options_.baseUrl!,
      channelId: this.options_.channelId!,
      apiToken: this.options_.apiToken!,
      onStatus: this.onStatus_,
      onApiVersion: this.onApiVersion_,
      rateLimitGate: this.rateLimitGate_,
    })
    return this.client_
  }

  // For the admin's status check: no retries and a short timeout, so a hung
  // Print Trail can't leave the settings page spinning for minutes.
  async getStatusClient(): Promise<PrintTrailClient> {
    this.assertConnected()
    this.statusClient_ ??= new PrintTrailClient({
      baseUrl: this.options_.baseUrl!,
      channelId: this.options_.channelId!,
      apiToken: this.options_.apiToken!,
      ...STATUS_CLIENT_TUNING,
      onStatus: this.onStatus_,
      onApiVersion: this.onApiVersion_,
      rateLimitGate: this.rateLimitGate_,
    })
    return this.statusClient_
  }

  private assertConnected(): void {
    if (!isConnected(this.options_)) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "Print Trail API is not connected")
    }
  }

  async getState<T>(key: string): Promise<T | null> {
    const [row] = await this.listPrintTrailStates({ key })
    return (row?.value as T | undefined) ?? null
  }

  async setState(key: string, value: unknown): Promise<void> {
    const [row] = await this.listPrintTrailStates({ key })
    const data = value as Record<string, unknown>
    if (row) {
      await this.replaceStateValue(row.id, data)
      return
    }
    try {
      await this.createPrintTrailStates({ key, value: data })
    } catch (e) {
      // Another writer created the key first (unique on key): update instead.
      const [raced] = await this.listPrintTrailStates({ key })
      if (!raced) throw e
      await this.replaceStateValue(raced.id, data)
    }
  }

  // Medusa's repository updates with mergeObjectProperties, so an update
  // merges a JSON object into the stored one and a removed key would stay.
  // Clearing it first replaces it; one transaction, so no reader sees null.
  @InjectTransactionManager()
  protected async replaceStateValue(
    id: string,
    value: Record<string, unknown> | null,
    @MedusaContext() sharedContext: Context = {}
  ): Promise<void> {
    await this.updatePrintTrailStates({ id, value: null }, sharedContext)
    if (value !== null) await this.updatePrintTrailStates({ id, value }, sharedContext)
  }

  // A queue of ids as one print_trail_state row each (`${prefix}${id}`), so
  // concurrent writers never lose each other's ids. Ids already queued stay
  // as they are.
  async queueStateKeys(prefix: string, ids: string[]): Promise<void> {
    const keys = [...new Set(ids)].map((id) => `${prefix}${id}`)
    if (!keys.length) return
    const existing = new Set((await this.listPrintTrailStates({ key: keys }, { select: ["key"] })).map((r) => r.key))
    const missing = keys.filter((k) => !existing.has(k))
    if (!missing.length) return
    const value = { queuedAt: new Date().toISOString() }
    try {
      await this.createPrintTrailStates(missing.map((key) => ({ key, value })))
    } catch {
      // Another writer queued some of them meanwhile: one at a time.
      await createEachUnlessExists(
        missing,
        (key) => this.createPrintTrailStates({ key, value }),
        async (key) => (await this.listPrintTrailStates({ key }, { select: ["id"] })).length > 0
      )
    }
  }

  // SKUs seen on pre-order (src/lib/pre-order.ts): add-only, one state row
  // per normalised SKU.
  async markPreOrderSeen(skus: string[]): Promise<void> {
    const ids = [...new Set(skus.map(normaliseSku).filter(Boolean))]
    for (let i = 0; i < ids.length; i += SEEN_CHUNK) {
      await this.queueStateKeys(PRE_ORDER_SEEN_PREFIX, ids.slice(i, i + SEEN_CHUNK))
    }
  }

  async preOrderSeen(skus: string[]): Promise<string[]> {
    const ids = [...new Set(skus.map(normaliseSku).filter(Boolean))]
    const have = new Set<string>()
    for (let i = 0; i < ids.length; i += SEEN_CHUNK) {
      const keys = ids.slice(i, i + SEEN_CHUNK).map((id) => `${PRE_ORDER_SEEN_PREFIX}${id}`)
      for (const r of await this.listPrintTrailStates({ key: keys }, { select: ["key"] })) have.add(r.key)
    }
    return skus.filter((s) => have.has(`${PRE_ORDER_SEEN_PREFIX}${normaliseSku(s)}`))
  }

  // print_trail_variant: one row per checked variant (src/lib/variant-checks.ts).

  // variant id → its row, for the variants that have one.
  async variantRows(variantIds: string[]): Promise<Map<string, VariantCheckRow>> {
    const out = new Map<string, VariantCheckRow>()
    for (const ids of chunks([...new Set(variantIds)], VARIANT_ROW_CHUNK)) {
      for (const r of await this.listPrintTrailVariants({ variant_id: ids })) out.set(r.variant_id, r as VariantCheckRow)
    }
    return out
  }

  // Creates the variant's row, or replaces every check column of it.
  async writeVariantCheck(input: { variantId: string; productId: string; check: SkuCheck | null; source: CheckSource }): Promise<void> {
    const columns = { ...checkColumns(input.check, input.source), product_id: input.productId }
    const [row] = await this.listPrintTrailVariants({ variant_id: input.variantId }, { select: ["id"] })
    if (row) {
      await this.updatePrintTrailVariants({ id: row.id, ...columns })
      return
    }
    try {
      await this.createPrintTrailVariants({ variant_id: input.variantId, ...columns })
    } catch (e) {
      // Another writer created the row first (unique on variant_id).
      const [raced] = await this.listPrintTrailVariants({ variant_id: input.variantId }, { select: ["id"] })
      if (!raced) throw e
      await this.updatePrintTrailVariants({ id: raced.id, ...columns })
    }
  }

  // Legacy checks from variant metadata, created only where the variant has
  // no row: a row written meanwhile wins. Returns how many were created.
  async adoptVariantChecks(rows: { variantId: string; productId: string; check: SkuCheck }[]): Promise<number> {
    let created = 0
    for (const chunk of chunks(rows, VARIANT_ROW_CHUNK)) {
      const existing = await this.variantRows(chunk.map((r) => r.variantId))
      const seen = new Set<string>()
      const missing = chunk.filter((r) => !existing.has(r.variantId) && !seen.has(r.variantId) && seen.add(r.variantId))
      if (!missing.length) continue
      const data = (r: (typeof missing)[number]): VariantRowInput => ({
        variant_id: r.variantId,
        product_id: r.productId,
        ...checkColumns(r.check, "metadata"),
      })
      try {
        await this.createPrintTrailVariants(missing.map(data))
        created += missing.length
      } catch {
        // A row was created meanwhile, or one of them can't be stored: one at
        // a time.
        for (const r of missing) {
          if (await this.adoptOne(data(r))) created++
        }
      }
    }
    return created
  }

  // One legacy check's row; whether it was created. After a failed create,
  // the variant's row is looked for: a row written meanwhile wins, and a
  // database that can't be read throws, so the scan keeps its cursor and
  // tries the page again. With no row, the create is tried once more, so a
  // passing failure isn't taken for a bad row; failing again, the check is
  // skipped and logged, so one row the database refuses can't hold the scan
  // back for good. (Its legacy key is still deleted: the variant is checked
  // again when it's next saved.) The error itself isn't relied on: Postgres
  // gives some refusals of a row's data a connection-class code.
  private async adoptOne(data: VariantRowInput): Promise<boolean> {
    const hasRow = async () => (await this.listPrintTrailVariants({ variant_id: data.variant_id }, { select: ["id"] })).length > 0
    let error: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.createPrintTrailVariants(data)
        return true
      } catch (e) {
        error = e
      }
      if (await hasRow()) return false
    }
    const reason = String((error as Error)?.message ?? error).split("\n")[0]
    this.logger_?.warn(`Print Trail: skipped the SKU check in variant ${data.variant_id}'s metadata, which couldn't be stored: ${reason}`)
    return false
  }

  // Hard-deletes the rows of these variants, or of these products' variants.
  async forgetVariants(filter: { variantIds?: string[]; productIds?: string[] }): Promise<number> {
    let deleted = 0
    const sets: [keyof VariantCheckRow, string[]][] = [
      ["variant_id", filter.variantIds ?? []],
      ["product_id", filter.productIds ?? []],
    ]
    for (const [column, values] of sets) {
      for (const ids of chunks([...new Set(values)], VARIANT_ROW_CHUNK)) {
        const rows = await this.listPrintTrailVariants({ [column]: ids }, { select: ["id"] })
        if (!rows.length) continue
        await this.deletePrintTrailVariants(rows.map((r) => r.id))
        deleted += rows.length
      }
    }
    return deleted
  }

  // The distinct SKUs whose check is not-found, for the unmatched notice.
  async notFoundSkus(): Promise<string[]> {
    const rows = await this.listPrintTrailVariants({ check_status: "not-found" }, { select: ["check_sku"] })
    const out = new Map<string, string>()
    for (const r of rows) {
      const k = normaliseSku(r.check_sku)
      if (k && !out.has(k)) out.set(k, r.check_sku!.trim())
    }
    return [...out.values()]
  }

  // Up to `take` rows with ids after `after` (null: from the first), by id
  // ascending: keyset, so a row deleted behind the cursor hides none.
  async variantRowPage(after: string | null, take: number): Promise<VariantCheckRow[]> {
    const rows = await this.listPrintTrailVariants(after === null ? {} : { id: { $gt: after } }, { take, order: { id: "ASC" } })
    return rows as VariantCheckRow[]
  }

  // The stock sync's status writes: each row is re-read and written only
  // while its SKU and status are still those it read. Compare-then-set, not
  // atomic: a SKU check landing in between can be overwritten, and the next
  // sync or save corrects it. Returns how many were written.
  async setCheckStatuses(updates: CheckStatusUpdate[]): Promise<number> {
    let written = 0
    for (const chunk of chunks(updates, VARIANT_ROW_CHUNK)) {
      const rows = await this.listPrintTrailVariants(
        { id: chunk.map((u) => u.id) },
        { select: ["id", "check_sku", "check_status"] }
      )
      const byId = new Map(rows.map((r) => [r.id, r]))
      const writes = chunk.flatMap((u) => {
        const r = byId.get(u.id)
        if (!r || r.check_sku !== u.expect.sku || r.check_status !== u.expect.status) return []
        return [
          u.status === null
            ? { id: u.id, ...checkColumns(null, "stock-sync") }
            : { id: u.id, check_status: u.status, checked_at: u.at, check_source: "stock-sync" },
        ]
      })
      if (!writes.length) continue
      await this.updatePrintTrailVariants(writes)
      written += writes.length
    }
    return written
  }

  // Removes and returns up to `limit` queued ids, oldest first. Callers hold
  // a lock, so there is one taker at a time.
  async takeStateKeys(prefix: string, limit: number): Promise<string[]> {
    const rows = await this.listPrintTrailStates(
      { key: { $like: `${prefix}%` } },
      { take: limit, order: { created_at: "ASC", key: "ASC" }, select: ["id", "key"] }
    )
    if (!rows.length) return []
    await this.deletePrintTrailStates(rows.map((r) => r.id))
    return rows.map((r) => r.key.slice(prefix.length))
  }
}

export default PrintTrailModuleService
