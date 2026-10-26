import { createHmac } from "node:crypto"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { startMockPrintTrail, type MockPrintTrail } from "../../../dev/mock-print-trail"
import { PrintTrailClient } from "../../modules/printTrail/client/client"
import type { MatchRow } from "../sync-decisions"
import {
  handlePrintTrailWebhook,
  PRINT_TRAIL_COPY_SEEN_EVENT,
  PRINT_TRAIL_STOCK_CHANGED_EVENT,
  PRINT_TRAIL_WEBHOOK_EVENT,
  type WebhookDeps,
  type WebhookReply,
} from "../webhook"

const sign = (body: string, secret = "mock-secret") => createHmac("sha256", secret).update(body).digest("hex")

let mock: MockPrintTrail
let client: PrintTrailClient
let server: http.Server
let url: string
let deps: WebhookDeps
let emitted: { name: string; data: unknown }[]
let logs: string[]
let rows: MatchRow[]
let replies: WebhookReply[]

beforeEach(async () => {
  mock = await startMockPrintTrail({ token: "t", channelId: "acme-medusa1", skus: { "978-A": 10 } })
  client = new PrintTrailClient({ baseUrl: mock.url, channelId: "acme-medusa1", apiToken: "t", retryDelays: [0] })
  emitted = []
  logs = []
  rows = []
  replies = []
  const log = (m: string) => void logs.push(m)
  deps = {
    secrets: ["mock-secret"],
    emit: async (msg) => void emitted.push(msg),
    find: {
      byUuid: async (u) => rows.find((r) => r.pt_uuid === u) ?? null,
      byNumber: async (n) => rows.filter((r) => r.pt_order_number === n),
    },
    logger: { info: log, warn: log, error: log, debug: log },
  }
  // Stands in for the Medusa route: forwards the raw bytes and the header.
  server = http.createServer(async (req, res) => {
    let raw = ""
    for await (const chunk of req) raw += chunk
    const reply = await handlePrintTrailWebhook(
      { rawBody: Buffer.from(raw), signature: req.headers.signature as string | undefined },
      deps
    )
    replies.push(reply)
    res.writeHead(reply.status, { "Content-Type": "application/json" })
    res.end(JSON.stringify(reply.body))
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks/print-trail`
})

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  await mock.close()
})

const order = async (number = "ORD-1001") =>
  client.createOrder({ orderNumber: number, orderLines: [{ quantity: 1, lineNumber: "item_a", product: { sku: "978-A" } }] })

describe("handlePrintTrailWebhook", () => {
  it("accepts a signed order event for a known order and emits it", async () => {
    const o = await order()
    rows.push({ id: "ptord_1", order_id: "order_1", pt_uuid: o.uuid, pt_order_number: "ORD-1001" })
    const reply = await mock.sendWebhook("fulfilment-status-updated", o.uuid, { url })
    expect(reply).toEqual({ status: 202, body: { status: "accepted" } })
    expect(emitted).toEqual([
      {
        name: PRINT_TRAIL_WEBHOOK_EVENT,
        data: { print_trail_order_id: "ptord_1", order_id: "order_1", notification_type: "fulfilment-status-updated" },
      },
    ])
  })

  // API 1.1.3: always arrays now, but before it they could
  // arrive as objects keyed "0", "1", …. The receiver reads neither.
  it.each([
    ["fulfilment-status-updated", { products: ["978-A"] }],
    ["fulfilment-status-updated", { products: { 0: "978-A" } }],
    ["fulfilment-tracking-created", { currentTrackingDetails: [{ trackingNumber: "T1", methodCode: "tracked" }] }],
    ["fulfilment-tracking-created", { currentTrackingDetails: { 1: { trackingNumber: "T1", methodCode: "tracked" } } }],
  ])("accepts %s with %j, as an array or keyed object", async (type, extra) => {
    const o = await order()
    rows.push({ id: "ptord_1", order_id: "order_1", pt_uuid: o.uuid, pt_order_number: "ORD-1001" })
    const reply = await mock.sendWebhook(type, o.uuid, { url, extra })
    expect(reply.status).toBe(202)
    expect(emitted).toEqual([
      { name: PRINT_TRAIL_WEBHOOK_EVENT, data: { print_trail_order_id: "ptord_1", order_id: "order_1", notification_type: type } },
    ])
  })

  it("rejects a bad signature", async () => {
    const o = await order()
    rows.push({ id: "ptord_1", order_id: "order_1", pt_uuid: o.uuid, pt_order_number: "ORD-1001" })
    expect((await mock.sendWebhook("order-status-updated", o.uuid, { url, signature: "00ff" })).status).toBe(401)
    expect((await mock.sendWebhook("order-status-updated", o.uuid, { url, secret: "other" })).status).toBe(401)
    expect(emitted).toEqual([])
  })

  it("rejects any webhook when the secret is empty", async () => {
    deps.secrets = []
    const reply = await mock.sendWebhook("order-status-updated", undefined, { url })
    expect(reply).toEqual({ status: 401, body: { message: "Invalid signature" } })
    expect(logs.some((l) => l.includes("Test connection"))).toBe(true)
    expect(emitted).toEqual([])
  })

  it("accepts a signature made with the previous secret during a rotation", async () => {
    deps.secrets = ["new-secret", "mock-secret", ""]
    const o = await order()
    rows.push({ id: "ptord_1", order_id: "order_1", pt_uuid: o.uuid, pt_order_number: "ORD-1001" })
    expect((await mock.sendWebhook("order-status-updated", o.uuid, { url })).status).toBe(202)
    expect((await mock.sendWebhook("order-status-updated", o.uuid, { url, secret: "new-secret" })).status).toBe(202)
    expect((await mock.sendWebhook("order-status-updated", o.uuid, { url, secret: "" })).status).toBe(401)
    expect((await mock.sendWebhook("order-status-updated", o.uuid, { url, secret: "other" })).status).toBe(401)
  })

  it("rejects a missing raw body", async () => {
    const reply = await handlePrintTrailWebhook({ rawBody: undefined, signature: sign("") }, deps)
    expect(reply.status).toBe(401)
    const noHeader = await handlePrintTrailWebhook({ rawBody: "{}", signature: undefined }, deps)
    expect(noHeader.status).toBe(401)
    expect(emitted).toEqual([])
  })

  it("verifies the raw bytes, not re-serialised JSON", async () => {
    const o = await order()
    rows.push({ id: "ptord_1", order_id: "order_1", pt_uuid: o.uuid, pt_order_number: "ORD-1001" })
    const body = `{ "orderUuid" : "${o.uuid}",\n  "notificationType":"order-status-updated" }`
    const reply = await mock.sendWebhook("ignored", undefined, { url, body, signature: sign(body) })
    expect(reply.status).toBe(202)
  })

  it("answers 400 when notificationType is missing", async () => {
    const body = JSON.stringify({ orderUuid: "x" })
    expect((await mock.sendWebhook("x", undefined, { url, body, signature: sign(body) })).status).toBe(400)
    const junk = "not json"
    expect((await mock.sendWebhook("x", undefined, { url, body: junk, signature: sign(junk) })).status).toBe(400)
    expect((await mock.sendWebhook("order-created", undefined, { url })).status).toBe(400)
  })

  it("answers 200 and logs for an unknown uuid", async () => {
    const o = await order()
    const reply = await mock.sendWebhook("order-status-updated", o.uuid, { url })
    expect(reply).toEqual({ status: 200, body: { status: "ignored" } })
    expect(logs.some((l) => l.includes(o.uuid) && l.includes("ORD-1001"))).toBe(true)
    expect(emitted).toEqual([])
  })

  it("routes a -COPY order to copy_seen and never to sync", async () => {
    const o = await order()
    rows.push({ id: "ptord_1", order_id: "order_1", pt_uuid: o.uuid, pt_order_number: "ORD-1001" })
    const copy = mock.copy(o.uuid)
    expect((await mock.sendWebhook("order-created", copy, { url })).status).toBe(202)
    expect(emitted).toEqual([
      {
        name: PRINT_TRAIL_COPY_SEEN_EVENT,
        data: { print_trail_order_id: "ptord_1", order_id: "order_1", copy_uuid: copy, copy_order_number: "ORD-1001-COPY" },
      },
    ])
  })

  it("passes a uuid hint for our own order whose uuid wasn't stored", async () => {
    const o = await order()
    rows.push({ id: "ptord_1", order_id: "order_1", pt_uuid: null, pt_order_number: "ORD-1001" })
    expect((await mock.sendWebhook("order-created", o.uuid, { url })).status).toBe(202)
    expect(emitted[0]).toEqual({
      name: PRINT_TRAIL_WEBHOOK_EVENT,
      data: { print_trail_order_id: "ptord_1", order_id: "order_1", notification_type: "order-created", pt_uuid_hint: o.uuid },
    })
  })

  it("hands stock-level-updated to the stock hook without patching from it", async () => {
    mock.state.preOrderRelease = false
    const reply = await mock.sendWebhook("stock-level-updated", undefined, { url, extra: { changedAt: "2026-10-19T12:00:00Z" } })
    expect(reply.status).toBe(202)
    // Items without status (an older Print Trail API) list nothing.
    expect(emitted).toEqual([
      { name: PRINT_TRAIL_STOCK_CHANGED_EVENT, data: { changed_at: "2026-10-19T12:00:00Z", activated_skus: [], held_skus: [] } },
    ])
  })

  // API 1.3.0: the item's status is a hint which waiting rows to re-read. Only
  // active releases: an inactive product's orders stay held as pre-order. A
  // pre-order or inactive item is listed with its status (held_skus): its
  // out-of-stock back-orders become pre-order with no order webhook.
  it("a stock event lists its activated SKUs, active only, and its held ones with their status", async () => {
    const products = [
      { sku: "P", productUuid: "p1", stock: 0, status: "pre-order" },
      { sku: "A", productUuid: "p2", stock: 4, status: "active" },
      { sku: "I", productUuid: "p3", stock: 0, status: "inactive" },
      { sku: "N", productUuid: "p4", stock: 1 },
      { sku: null, productUuid: "p5", stock: 1, status: "active" },
      "junk",
    ]
    const reply = await mock.sendWebhook("stock-level-updated", undefined, { url, extra: { changedAt: "2026-10-19T12:00:00Z", products } })
    expect(reply.status).toBe(202)
    expect(emitted).toEqual([
      {
        name: PRINT_TRAIL_STOCK_CHANGED_EVENT,
        data: {
          changed_at: "2026-10-19T12:00:00Z",
          activated_skus: ["A"],
          held_skus: [
            { sku: "P", status: "pre-order" },
            { sku: "I", status: "inactive" },
          ],
        },
      },
    ])
  })

  it("replies 503 when emit hangs", async () => {
    const o = await order()
    rows.push({ id: "ptord_1", order_id: "order_1", pt_uuid: o.uuid, pt_order_number: "ORD-1001" })
    deps.emit = () => new Promise(() => {})
    deps.emitTimeoutMs = 50
    const started = Date.now()
    const reply = await mock.sendWebhook("order-status-updated", o.uuid, { url })
    expect(reply).toEqual({ status: 503, body: { message: "Couldn't queue the webhook" } })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it("replies 503 when emit rejects", async () => {
    deps.emit = async () => {
      throw new Error("bus down")
    }
    expect((await mock.sendWebhook("stock-level-updated", undefined, { url })).status).toBe(503)
  })

  it("ignores an unknown notification type with 200", async () => {
    const reply = await mock.sendWebhook("something-new", "x", { url })
    expect(reply).toEqual({ status: 200, body: { status: "ignored" } })
    expect(emitted).toEqual([])
  })
})
