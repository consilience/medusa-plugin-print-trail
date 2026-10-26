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
import { createEachUnlessExists } from "../../lib/state-queue"
import { PrintTrailClient, STATUS_CLIENT_TUNING, type RateLimitGate } from "./client/client"
import { PROBLEM_TYPES } from "./client/errors"
import PrintTrailOrder from "./models/print-trail-order"
import PrintTrailOrderEvent from "./models/print-trail-order-event"
import PrintTrailState from "./models/print-trail-state"

export { AUTH_FAILED_STATE_KEY, CHANNEL_INACTIVE_STATE_KEY, type AuthFailedState } from "../../lib/auth-state"

type Logger = { warn(message: string): void }

const SEEN_CHUNK = 500

// CRUD only, plus the plugin options and the API client built from them.
// Business logic lives in workflows.
class PrintTrailModuleService extends MedusaService({
  PrintTrailOrder,
  PrintTrailOrderEvent,
  PrintTrailState,
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
