import type { CreateNotificationDTO } from "@medusajs/framework/types"
import { memoryPreOrderSeen } from "../pre-order"
import { startMockPrintTrail, type MockPrintTrail } from "../../../dev/mock-print-trail"
import { resolvePluginOptions, type RawPrintTrailPluginOptions } from "../../config"
import { PrintTrailClient } from "../../modules/printTrail/client/client"
import type { AdminNotifier } from "../cancel-flow"
import { snapshotFields, type PrintTrailOrderRow, type SendStore } from "../send-flow"
import type { SyncStore } from "../sync-flow"

// Shared by the cancel, amend and order-change flow tests: an in-memory
// store, the mock, and a recording notifier.

export const TOKEN = "flow-token"
export const NOW = new Date("2026-10-19T12:00:00Z")

export class MemoryStore implements SendStore, SyncStore {
  // The activation scan's record, as the service keeps it.
  seen = memoryPreOrderSeen()
  async markPreOrderSeen(skus: string[]) {
    await this.seen.markPreOrderSeen(skus)
  }
  rows: PrintTrailOrderRow[] = []
  events: Record<string, any>[] = []
  private n = 0

  async listPrintTrailOrders(filters: Record<string, unknown>) {
    return this.rows
      .filter((r) =>
        Object.entries(filters).every(([k, v]) => (Array.isArray(v) ? v.includes(r[k]) : (r[k] ?? null) === v))
      )
      .map((r) => ({ ...r }))
  }
  async createPrintTrailOrders(data: Record<string, unknown>) {
    const row = { id: `ptord_${++this.n}`, sequence: 1, attempts: {}, confirmed_at: null, ...data } as PrintTrailOrderRow
    this.rows.push(row)
    return { ...row }
  }
  async updatePrintTrailOrders(data: Record<string, unknown>) {
    const row = this.rows.find((r) => r.id === data.id)!
    // As Medusa's repository (mergeObjectProperties): a JSON object is
    // merged into the stored one, so a key can't be removed by an update.
    const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)
    for (const [key, value] of Object.entries(data)) {
      row[key] = isObject(row[key]) && isObject(value) ? { ...(row[key] as Record<string, unknown>), ...value } : value
    }
    return { ...row }
  }
  async createPrintTrailOrderEvents(data: Record<string, unknown>[]) {
    this.events.push(...data)
    return data
  }
  async listPrintTrailOrderEvents(filters: Record<string, unknown>) {
    return this.events.filter((e) => Object.entries(filters).every(([k, v]) => e[k] === v)) as any
  }
  async ensureOrderLink() {}
  kinds(rowId?: string) {
    return this.events.filter((e) => !rowId || e.print_trail_order_id === rowId).map((e) => e.kind)
  }
  row(id: string) {
    return this.rows.find((r) => r.id === id)!
  }
}

export class RecordingNotifier implements AdminNotifier {
  sent: CreateNotificationDTO[] = []
  fail = false
  async notify(n: CreateNotificationDTO[]) {
    if (this.fail) throw new Error("provider down")
    this.sent.push(...n)
  }
}

export async function startFlowMock(): Promise<MockPrintTrail> {
  return startMockPrintTrail({
    token: TOKEN,
    channelId: "acme-medusa1",
    skus: { "978-A": 10, "978-B": 10, "POD-1": 10000, "US-1": 5 },
    locations: { "US-1": "US1" },
    methodsByLocation: { US1: ["standard"] },
  })
}

export function flowOptions(mock: MockPrintTrail, over: RawPrintTrailPluginOptions = {}) {
  return resolvePluginOptions({
    baseUrl: mock.url,
    channelId: "acme-medusa1",
    apiToken: TOKEN,
    orderNumberPrefix: "ORD-",
    adminUrl: "https://admin.example/app",
    appUrl: "https://app.example",
    ...over,
    notifications: { adminEmail: ["ops@shop.test", "boss@shop.test"], ...over.notifications },
  })
}

export function flowClient(mock: MockPrintTrail) {
  return new PrintTrailClient({ baseUrl: mock.url, channelId: "acme-medusa1", apiToken: TOKEN, retryDelays: [0] })
}

export type PlacedLine = { lineNumber: string; sku: string; quantity: number }

// A Print Trail order created (and confirmed unless `draft`) at the mock,
// with its row as the send flow would have left it.
export async function placeAtMock(
  mock: MockPrintTrail,
  store: MemoryStore,
  opts: { orderNumber?: string; sequence?: number; lines?: PlacedLine[]; draft?: boolean; orderId?: string; sourceRef?: string | null } = {}
): Promise<PrintTrailOrderRow> {
  const client = flowClient(mock)
  const lines = opts.lines ?? [{ lineNumber: "item_a", sku: "978-A", quantity: 1 }]
  const orderNumber = opts.orderNumber ?? "ORD-1001"
  const submitted = lines.map((l) => ({ quantity: l.quantity, lineNumber: l.lineNumber, product: { sku: l.sku } }))
  let pt = await client.createOrder({ orderNumber, strictSkus: true, reserve: false, orderLines: submitted })
  if (!opts.draft) {
    pt = await client.confirmOrder(pt.uuid, {})
  }
  return store.createPrintTrailOrders({
    order_id: opts.orderId ?? "order_1",
    sequence: opts.sequence ?? 1,
    pt_order_number: orderNumber,
    source_ref: opts.sourceRef ?? null,
    ...snapshotFields(pt, NOW),
    submitted_lines: submitted,
    confirmed_at: opts.draft ? null : NOW,
    pending_action: null,
    next_attempt_at: null,
    cancel_requested: false,
    cancel_status: null,
    attention: null,
  })
}
