import { createHmac } from "node:crypto"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { startMockPrintTrail, type MockPrintTrail } from "../../../../dev/mock-print-trail"
import { PrintTrailClient } from "../client/client"
import { PrintTrailApiError } from "../client/errors"

const TOKEN = "contract-token"

let mock: MockPrintTrail
let client: PrintTrailClient

const caught = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e as PrintTrailApiError
  }
  throw new Error("expected a rejection")
}

const draft = (orderNumber: string, lines = [{ sku: "9780000000002", quantity: 1 }]) => ({
  orderNumber,
  strictSkus: true,
  orderLines: lines.map((l, i) => ({
    quantity: l.quantity,
    lineNumber: `item_${i}`,
    product: { sku: l.sku },
  })),
})

beforeEach(async () => {
  mock = await startMockPrintTrail({
    token: TOKEN,
    channelId: "acme-medusa1",
    skus: { "9780000000002": 25, "9780000000019": 0, "POD-1": 10000, "US-1": 5 },
    locations: { "US-1": "US1" },
    methodsByLocation: { US1: ["standard"] },
  })
  client = new PrintTrailClient({
    baseUrl: mock.url,
    channelId: "acme-medusa1",
    apiToken: TOKEN,
    retryDelays: [0],
  })
})

afterEach(() => mock.close())

describe("client against the mock", () => {
  it("reads the channel, token, methods, stock and connection", async () => {
    await expect(client.testConnection()).resolves.toMatchObject({ message: "Connection OK" })
    await expect(client.getToken()).resolves.toEqual({
      teamCode: "acme",
      channelCode: "medusa1",
      channelId: "acme-medusa1",
    })
    await expect(client.getChannel()).resolves.toMatchObject({
      code: "medusa1",
      webhookDetail: { uri: null },
      team: { name: "Testing", code: "acme" },
    })
    expect((await client.listShippingMethods()).map((m) => m.code)).toEqual([
      "standard",
      "express",
      "air",
      "tracked",
    ])
    expect(await client.stockLevels()).toContainEqual(expect.objectContaining({ sku: "POD-1", stock: 10000 }))
  })

  it("registers a webhook URL", async () => {
    const { channel: ch, secret } = await client.registerWebhook("https://store.example/hooks/print-trail")
    expect(ch.webhookDetail?.uri).toBe("https://store.example/hooks/print-trail")
    expect(secret).toBe("mock-secret")
    mock.state.legacy = true
    expect((await client.registerWebhook("https://store.example/hooks/print-trail")).secret).toBeNull()
  })

  it("validates SKUs case-insensitively", async () => {
    const v = await client.validateSkus(["pod-1", "nope"])
    expect(v.results).toEqual([
      expect.objectContaining({ sku: "pod-1", state: "matched", matchedSku: "POD-1", status: "active" }),
      { sku: "nope", state: "unknown" },
    ])
  })

  it("creates, finds, confirms and fetches an order", async () => {
    const created = await client.createOrder(draft("ORD-1"))
    expect(created.status).toBe("draft")
    expect(created.fulfilments).toHaveLength(1)
    await expect(client.findOrderByNumber("ORD-1")).resolves.toMatchObject({ uuid: created.uuid })
    await expect(client.findOrderByNumber("ORD-9")).resolves.toBeNull()

    const confirmed = await client.confirmOrder(created.uuid, { defaultShippingMethod: "tracked" })
    expect(confirmed.status).toBe("queued")
    expect(confirmed.fulfillableFrom).toBeTruthy()
    expect(confirmed.fulfilments![0].uuid).not.toBe(created.fulfilments![0].uuid)
    await expect(client.getOrder(created.uuid)).resolves.toMatchObject({ status: "queued" })
  })

  it("refuses to re-post a confirmed order with a 409 problem", async () => {
    const created = await client.createOrder(draft("ORD-2"))
    await client.confirmOrder(created.uuid, {})
    const err = await caught(client.createOrder(draft("ORD-2")))
    expect(err.status).toBe(409)
    expect(err.isProblem).toBe(true)
    expect(err.detail).toContain("already been confirmed")
  })

  it("rejects unknown SKUs with strictSkus", async () => {
    const err = await caught(client.createOrder(draft("ORD-3", [{ sku: "NOPE", quantity: 1 }])))
    expect(err.status).toBe(422)
    expect(err.unmatchedSkus).toEqual(["NOPE"])
  })

  it("reports a stock shortfall on confirm, and leaves the order draft", async () => {
    const created = await client.createOrder(draft("ORD-4", [{ sku: "9780000000019", quantity: 2 }]))
    const err = await caught(client.confirmOrder(created.uuid, {}))
    expect(err.stockShortfall).toEqual([{ sku: "9780000000019", requested: 2, available: 0 }])
    await expect(client.getOrder(created.uuid)).resolves.toMatchObject({ status: "draft" })
  })

  it("returns regenerated fulfilments on a shipping-selection conflict", async () => {
    const created = await client.createOrder(
      draft("ORD-5", [
        { sku: "9780000000002", quantity: 1 },
        { sku: "US-1", quantity: 1 },
      ])
    )
    expect(created.fulfilments).toHaveLength(2)
    const err = await caught(client.confirmOrder(created.uuid, { defaultShippingMethod: "tracked" }))
    expect(err.status).toBe(409)
    const order = err.shippingConflictOrder!
    expect(order.uuid).toBe(created.uuid)
    const us = order.fulfilments!.find((f) => f.supplierLocation?.code === "US1")!
    expect(us.uuid).not.toBe(created.fulfilments!.find((f) => f.supplierLocation?.code === "US1")!.uuid)
    expect(us.availableShippingMethods!.map((m) => m.code)).toEqual(["standard"])
  })

  it("422s an unknown shipping code on confirm", async () => {
    const created = await client.createOrder(draft("ORD-6"))
    const err = await caught(client.confirmOrder(created.uuid, { defaultShippingMethod: "tracked-48" }))
    expect(err.status).toBe(422)
  })

  it("cancels a draft at once and refuses after dispatch", async () => {
    const a = await client.createOrder(draft("ORD-7"))
    await expect(client.cancelOrder(a.uuid)).resolves.toMatchObject({
      status: 200,
      order: { status: "cancelled" },
    })
    const b = await client.createOrder(draft("ORD-8"))
    await client.confirmOrder(b.uuid, {})
    mock.dispatch(b.uuid)
    expect((await caught(client.cancelOrder(b.uuid))).status).toBe(428)
  })

  it("amends lines while every fulfilment is still draft", async () => {
    const created = await client.createOrder(
      draft("ORD-9", [
        { sku: "9780000000002", quantity: 2 },
        { sku: "POD-1", quantity: 1 },
      ])
    )
    const { order, amendment } = await client.amendLines(created.uuid, {
      orderLines: [{ lineNumber: "item_0", quantity: 1 }],
    })
    expect(amendment.result).toBe("amended")
    expect(amendment.changes).toEqual([
      expect.objectContaining({ lineNumber: "item_0", change: "quantity_changed", from: 2, to: 1 }),
      expect.objectContaining({ lineNumber: "item_1", change: "removed", to: 0 }),
    ])
    expect(order!.orderLines).toHaveLength(1)
  })

  it("pages through orders updated since a date", async () => {
    for (let i = 0; i < 25; i++) {
      await client.createOrder(draft(`ORD-P${i}`))
    }
    const seen: string[] = []
    for await (const o of client.listOrdersUpdatedSince("2000-01-01T00:00:00Z")) {
      seen.push(o.orderNumber!)
    }
    expect(seen).toHaveLength(25)
    expect(mock.state.requests.filter((r) => r.path.startsWith("/v1/channels/acme-medusa1/orders?"))).toHaveLength(2)
  })
})

describe("mock error shapes", () => {
  it("401s a wrong token with a problem document", async () => {
    const bad = new PrintTrailClient({ baseUrl: mock.url, channelId: "acme-medusa1", apiToken: "wrong", retryDelays: [] })
    const err = await caught(bad.testConnection())
    expect(err.status).toBe(401)
    expect(err.isProblem).toBe(true)
  })

  it("401s an unknown channel as a bad token (API 1.2.0); legacy 404s it with a problem document", async () => {
    const bad = new PrintTrailClient({ baseUrl: mock.url, channelId: "acme-other", apiToken: TOKEN, retryDelays: [] })
    const err = await caught(bad.testConnection())
    expect(err.status).toBe(401)
    expect(err.body).toMatchObject({ status: 401, title: "Unauthorized", detail: "Unauthenticated." })
    mock.state.legacy = true
    const old = await caught(bad.testConnection())
    expect(old.status).toBe(404)
    expect(old.isProblem).toBe(true)
    expect(old.detail).toContain('"acme-other" does not exist')
  })

  it("404s an unknown route with a plain body", async () => {
    const bad = new PrintTrailClient({ baseUrl: `${mock.url}/not-print-trail`, channelId: "acme-medusa1", apiToken: TOKEN, retryDelays: [] })
    const err = await caught(bad.testConnection())
    expect(err.status).toBe(404)
    expect(err.isProblem).toBe(false)
  })

  it("injects failures, then recovers", async () => {
    mock.fail(/\/test-connection$/, 503, undefined, 1)
    await expect(client.testConnection()).resolves.toMatchObject({ message: "Connection OK" })
    mock.fail(/\/test-connection$/, 428, { status: 428, detail: "nope", title: "x", type: "about:blank" }, 1)
    expect((await caught(client.testConnection())).status).toBe(428)
  })
})

describe("mock API 1.2.0 hardening", () => {
  const INACTIVE = "https://docs.printtrail.com/channel-api/problems/channel-inactive"

  it("an inactive channel gets a typed 403 on every endpoint and no webhooks", async () => {
    mock.state.webhookUrl = "http://127.0.0.1:1/hooks"
    mock.state.channelInactive = true
    for (const call of [() => client.getToken(), () => client.getChannel(), () => client.stockLevels(), () => client.createOrder(draft("ORD-I1"))]) {
      const err = await caught(call())
      expect(err.status).toBe(403)
      expect(err.problemType).toBe(INACTIVE)
      expect(err.isChannelInactive).toBe(true)
    }
    expect(await mock.sendWebhook("order-status-updated")).toEqual({ status: 0, body: null })
    mock.reset()
    await expect(client.getToken()).resolves.toMatchObject({ channelId: "acme-medusa1" })
  })

  it("an inactive team can read and cancel, not create, confirm, amend or register a webhook", async () => {
    const o = await client.createOrder(draft("ORD-T1"))
    const confirmed = await client.createOrder(draft("ORD-T2"))
    await client.confirmOrder(confirmed.uuid, { defaultShippingMethod: "standard" })
    mock.state.teamInactive = true
    await expect(client.getOrder(o.uuid)).resolves.toMatchObject({ uuid: o.uuid })
    const create = await caught(client.createOrder(draft("ORD-T3")))
    expect(create.status).toBe(403)
    expect(create.detail).toMatch(/^This team is inactive\./)
    expect(create.problemType).not.toBe(INACTIVE)
    const confirm = await caught(client.confirmOrder(o.uuid, { defaultShippingMethod: "standard" }))
    expect(confirm.status).toBe(403)
    expect(mock.state.orders.get(o.uuid).status).toBe("draft")
    // Already confirmed: still 202.
    await expect(client.confirmOrder(confirmed.uuid, {})).resolves.toMatchObject({ uuid: confirmed.uuid })
    const amend = await caught(client.amendLines(o.uuid, { orderLines: [{ lineNumber: "item_0", quantity: 2 }] }))
    expect(amend).toMatchObject({ status: 403, body: expect.objectContaining({ reason: "team-inactive" }) })
    const webhook = await caught(client.registerWebhook("https://shop.example.com/hooks/print-trail"))
    expect(webhook.status).toBe(403)
    expect(webhook.detail).toBe("This team is inactive. Webhooks cannot be registered.")
    await expect(client.cancelOrder(o.uuid)).resolves.toMatchObject({ status: 200 })
  })

  it("refuses requests over the input limits with violations", async () => {
    const long = "S".repeat(256)
    const tooLong = await caught(client.createOrder({ ...draft("N".repeat(256)), printTrailOrderNumber: "p".repeat(256) }))
    expect(tooLong.status).toBe(422)
    expect(tooLong.violations.map((v) => v.property)).toEqual(["orderNumber", "printTrailOrderNumber"])
    const lines = Array.from({ length: 501 }, (_, i) => ({ sku: "9780000000002", quantity: 1, n: i }))
    const many = await caught(client.createOrder({ ...draft("ORD-L1"), orderLines: lines.map((l) => ({ quantity: 1, lineNumber: `l${l.n}`, product: { sku: l.sku } })) }))
    expect(many.detail).toBe("orderLines: An order may have at most 500 order lines.")
    const sku = await caught(client.createOrder(draft("ORD-L2", [{ sku: long, quantity: 1 }])))
    expect(sku.violations).toEqual([{ property: "orderLines.0.product.sku", message: expect.stringContaining("255") }])
    const o = await client.createOrder(draft("ORD-L3"))
    const amend = await caught(client.amendLines(o.uuid, { orderLines: [{ lineNumber: "x", quantity: 1, product: { sku: long } }] }))
    expect(amend.status).toBe(422)
    // Characters, not UTF-16 units, as Print Trail counts them.
    await expect(client.createOrder(draft("📚".repeat(255)))).resolves.toMatchObject({ status: "draft" })
    // At the limits: accepted.
    await expect(client.createOrder({ ...draft("A".repeat(255)) })).resolves.toMatchObject({ orderNumber: "A".repeat(255) })
    // Legacy took them.
    mock.state.legacy = true
    await expect(client.createOrder(draft("B".repeat(256)))).resolves.toMatchObject({ status: "draft" })
  })

  it("applies the webhook URL rules, allowing local URLs by default", async () => {
    await expect(client.registerWebhook("http://localhost:9000/hooks/print-trail")).resolves.toMatchObject({ secret: "mock-secret" })
    const long = await caught(client.registerWebhook(`https://shop.example.com/${"a".repeat(200)}`))
    expect(long.detail).toBe("url: The webhook URL may not be longer than 200 characters.")
    expect((await caught(client.registerWebhook("https://u:p@shop.example.com/h"))).detail).toContain("user name or password")
    expect((await caught(client.registerWebhook("https://shop.example.com/h#x"))).detail).toContain("without a fragment")

    mock.state.allowLocalWebhooks = false
    for (const [url, why] of [
      ["http://shop.example.com/h", "must use https"],
      ["https://localhost/h", "internal name"],
      ["https://shop.local/h", "internal name"],
      ["https://db.internal/h", "internal name"],
      ["https://medusa/h", "internal name"],
      ["https://10.1.2.3/h", "non-public address"],
      ["https://127.0.0.1/h", "non-public address"],
      ["https://169.254.169.254/h", "non-public address"],
      ["https://[::1]/h", "non-public address"],
    ]) {
      const err = await caught(client.registerWebhook(url))
      expect(err.status).toBe(422)
      expect(err.violations[0]).toMatchObject({ property: "url", message: expect.stringContaining(why) })
    }
    await expect(client.registerWebhook("https://shop.example.com/hooks/print-trail")).resolves.toMatchObject({ secret: "mock-secret" })
    // A delivery is checked again: a refused URL is never sent to.
    mock.state.webhookUrl = "http://127.0.0.1:1/hooks"
    expect(await mock.sendWebhook("order-status-updated")).toEqual({ status: 0, body: null })
    // Legacy took any string.
    mock.state.legacy = true
    await expect(client.registerWebhook("http://localhost/h")).resolves.toBeTruthy()
  })

  it("injects a 429 with Retry-After and rate-limit headers, and a 500 with a reference", async () => {
    mock.fail(/\/token$/, 429, { type: "about:blank", title: "Too Many Requests", status: 429, detail: "Too many requests. Retry after 30 seconds." }, 1, {
      "Retry-After": "30",
      "X-RateLimit-Limit": "600",
      "X-RateLimit-Remaining": "0",
    })
    const limited = await caught(new PrintTrailClient({ baseUrl: mock.url, channelId: "acme-medusa1", apiToken: TOKEN }).getToken())
    expect(limited).toMatchObject({ status: 429, retryAfterMs: 30_000 })
    mock.fail(/\/token$/, 500, { title: "Internal Server Error", status: 500, detail: "An unexpected error occurred. If it keeps happening, contact Print Trail support quoting reference r-1.", reference: "r-1" }, 1)
    const failed = await caught(new PrintTrailClient({ baseUrl: mock.url, channelId: "acme-medusa1", apiToken: TOKEN, retryDelays: [] }).getToken())
    expect(failed.reference).toBe("r-1")
  })
})

describe("mock keyset paging", () => {
  const walk = async (since: string, afterFirstPage?: () => void) => {
    const pages: string[][] = []
    for await (const page of client.ordersUpdatedSincePages(since)) {
      pages.push(page.map((o) => o.uuid))
      if (pages.length === 1) afterFirstPage?.()
    }
    return pages
  }
  const create45 = async () => {
    for (let i = 0; i < 45; i++) {
      await client.createOrder(draft(`ORD-K${i}`))
    }
    return [...mock.state.orders.keys()]
  }

  it("walks 45 orders in pages of 20, 20 and 5", async () => {
    await create45()
    const pages = await walk("2000-01-01T00:00:00Z")
    expect(pages.map((p) => p.length)).toEqual([20, 20, 5])
    expect(new Set(pages.flat()).size).toBe(45)
  })

  it("loses no order updated during the walk", async () => {
    await create45()
    const first = await walk("2000-01-01T00:00:00Z")
    const moved = first[1][3]
    const pages = await walk("2000-01-01T00:00:00Z", () => mock.setUpdatedAt(moved, "2999-01-01T00:00:00Z"))
    const all = pages.flat()
    expect(all.filter((u) => u === moved)).toHaveLength(1)
    expect(new Set(all).size).toBe(45)
  })

  it("includes an order updated exactly at updated-since", async () => {
    const created = await client.createOrder(draft("ORD-EQ"))
    mock.setUpdatedAt(created.uuid, "2026-10-19T12:00:00Z")
    const pages = await walk("2026-10-19T12:00:00Z")
    expect(pages.flat()).toEqual([created.uuid])
  })

  it("uses second-resolution timestamps", async () => {
    const created = await client.createOrder(draft("ORD-TS"))
    expect(created.updatedAt).toMatch(/T\d{2}:\d{2}:\d{2}Z$/)
  })

  it("422s a cursor it can't decode", async () => {
    const res = await fetch(`${mock.url}/v1/channels/acme-medusa1/orders?cursor=abc`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body).toMatchObject({ status: 422, type: "about:blank" })
    // As the client sees it when following a next link.
    const callUrl = (client as unknown as { callUrl(m: string, u: string): Promise<unknown> }).callUrl.bind(client)
    const err = await caught(callUrl("GET", `${mock.url}/v1/channels/acme-medusa1/orders?cursor=abc`))
    expect(err).toBeInstanceOf(PrintTrailApiError)
    expect(err.status).toBe(422)
    expect(err.isProblem).toBe(true)
  })
})

describe("mock webhooks", () => {
  let server: http.Server
  let received: { raw: string; headers: http.IncomingHttpHeaders }[]
  let hookUrl: string

  beforeEach(async () => {
    received = []
    server = http.createServer(async (req, res) => {
      let raw = ""
      for await (const chunk of req) raw += chunk
      received.push({ raw, headers: req.headers })
      res.writeHead(202, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "accepted" }))
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
    hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks/print-trail`
  })

  afterEach(() => new Promise<void>((r) => server.close(() => r())))

  it("signs the exact bytes it sends", async () => {
    const created = await client.createOrder(draft("ORD-1001"))
    const reply = await mock.sendWebhook("order-status-updated", created.uuid, { url: hookUrl })
    expect(reply).toEqual({ status: 202, body: { status: "accepted" } })
    const [{ raw, headers }] = received
    expect(headers.signature).toBe(createHmac("sha256", "mock-secret").update(raw).digest("hex"))
    expect(headers["content-type"]).toContain("application/json")
    expect(JSON.parse(raw)).toMatchObject({
      notificationType: "order-status-updated",
      tenantCode: "acme",
      channelCode: "medusa1",
      orderUuid: created.uuid,
      orderNumber: "ORD-1001",
    })
  })

  it("sends stock-level-updated without order fields", async () => {
    await mock.sendWebhook("stock-level-updated", undefined, { url: hookUrl })
    const body = JSON.parse(received[0].raw)
    expect(body.changedAt).toEqual(expect.any(String))
    expect(body.products).toEqual(expect.any(Array))
    expect(body).not.toHaveProperty("orderUuid")
  })

  it("lets a test override the signature and the bytes", async () => {
    await mock.sendWebhook("order-created", undefined, { url: hookUrl, signature: "bad", body: "{}" })
    expect(received[0]).toMatchObject({ raw: "{}", headers: expect.objectContaining({ signature: "bad" }) })
  })
})

describe("mock Print Trail-side helpers", () => {
  const confirmed = async (lines = [{ sku: "9780000000002", quantity: 1 }, { sku: "US-1", quantity: 1 }]) => {
    const created = await client.createOrder(draft("ORD-1001", lines))
    await client.confirmOrder(created.uuid, { defaultShippingMethod: "standard" })
    return created.uuid
  }

  it("dispatches without tracking, then adds it", async () => {
    const uuid = await confirmed()
    mock.dispatch(uuid, 0, { tracking: false })
    let o = await client.getOrder(uuid)
    expect(o.fulfilments![0]).toMatchObject({ status: "dispatched", trackingDetails: [] })
    mock.addTracking(uuid, 0)
    o = await client.getOrder(uuid)
    expect(o.fulfilments![0].trackingDetails).toHaveLength(1)
  })

  it("cancels one fulfilment and not the order", async () => {
    const uuid = await confirmed()
    mock.cancelFulfilment(uuid, 1)
    const o = await client.getOrder(uuid)
    expect(o.fulfilments![1].status).toBe("cancelled")
    expect(o.status).not.toBe("cancelled")
  })

  it("is processing between parcels, then partial (final) once the rest is cancelled", async () => {
    const uuid = await confirmed()
    mock.dispatch(uuid, 0)
    expect((await client.getOrder(uuid)).status).toBe("processing")
    mock.cancelFulfilment(uuid, 1)
    expect((await client.getOrder(uuid)).status).toBe("partial")
    mock.reset()
    const both = await confirmed()
    mock.dispatch(both, 0)
    mock.dispatch(both, 1)
    expect((await client.getOrder(both)).status).toBe("complete")
  })

  it("sets statuses and shipping methods", async () => {
    const uuid = await confirmed()
    mock.setStatus(uuid, "holding", "not-fulfillable")
    mock.setShippingMethod(uuid, 0, "express")
    const o = await client.getOrder(uuid)
    expect(o).toMatchObject({ status: "holding", fulfillableStatus: "not-fulfillable" })
    expect(o.fulfilments![0].requestedShippingMethod).toBe("express")
  })

  it("full-edits an order back to draft", async () => {
    const uuid = await confirmed()
    mock.fullEdit(uuid)
    const o = await client.getOrder(uuid)
    expect(o).toMatchObject({ status: "draft", fulfilments: [] })
    expect(o.orderLines).toHaveLength(2)
  })

  it("copies an order as a new draft", async () => {
    const uuid = await confirmed()
    const copy = mock.copy(uuid)
    expect(copy).not.toBe(uuid)
    expect(await client.getOrder(copy)).toMatchObject({ orderNumber: "ORD-1001-COPY", status: "draft" })
  })

  it("moves updatedAt on every change", async () => {
    const uuid = await confirmed()
    mock.setUpdatedAt(uuid, "2000-01-01T00:00:00Z")
    mock.setShippingMethod(uuid, 0, "air")
    expect((await client.getOrder(uuid)).updatedAt).not.toBe("2000-01-01T00:00:00Z")
  })
})


describe("SKU statuses and stock figures", () => {
  let own: MockPrintTrail
  const clientFor = (m: MockPrintTrail) =>
    new PrintTrailClient({ baseUrl: m.url, channelId: "acme-medusa1", apiToken: TOKEN, retryDelays: [0] })

  afterEach(() => own?.close())

  it("validate-skus reports inactive and pre-order", async () => {
    own = await startMockPrintTrail({ token: TOKEN, channelId: "acme-medusa1", skuStatus: { "9780000000019": "inactive" } })
    const v = await clientFor(own).validateSkus(["9780000000019", "nope"])
    expect(v.results).toEqual([
      expect.objectContaining({ sku: "9780000000019", state: "matched", status: "inactive" }),
      { sku: "nope", state: "unknown" },
    ])
    expect(v.summary).toEqual({ matched: 1, unknown: 1 })

    own.state.skuStatus["9780000000002"] = "pre-order"
    const p = await clientFor(own).validateSkus(["9780000000002"])
    expect(p.results[0]).toMatchObject({ state: "matched", status: "pre-order" })
  })

  it("validate-skus matches case-insensitively and returns the canonical SKU", async () => {
    own = await startMockPrintTrail({ token: TOKEN, channelId: "acme-medusa1", skus: { "abc-1": 4 } })
    const v = await clientFor(own).validateSkus(["ABC-1"])
    expect(v.results[0]).toMatchObject({ sku: "ABC-1", state: "matched", matchedSku: "abc-1", status: "active" })
  })

  it("stock-levels passes print-on-demand figures and null SKUs through", async () => {
    own = await startMockPrintTrail({ token: TOKEN, channelId: "acme-medusa1" })
    const c = clientFor(own)
    expect(await c.stockLevels()).toContainEqual(expect.objectContaining({ sku: "9780000000026", stock: 10003 }))
    expect((await c.stockLevels()).some((l) => l.sku === null)).toBe(false)
    own.state.nullSkuRows = 1
    const levels = await c.stockLevels()
    expect(levels.filter((l) => l.sku === null)).toEqual([expect.objectContaining({ sku: null, stock: 5 })])
  })
})

describe("mock cancel and amend contract", () => {
  const confirmed = async (orderNumber: string, lines?: { sku: string; quantity: number }[]) => {
    const created = await client.createOrder(draft(orderNumber, lines))
    return client.confirmOrder(created.uuid, {})
  }

  it("cancels a queued order with 200 and a processing one with 202", async () => {
    const a = await confirmed("ORD-C1")
    await expect(client.cancelOrder(a.uuid)).resolves.toMatchObject({ status: 200, order: { status: "cancelled" } })
    const b = await confirmed("ORD-C2")
    mock.setStatus(b.uuid, "processing")
    await expect(client.cancelOrder(b.uuid)).resolves.toMatchObject({ status: 202, order: { status: "processing" } })
  })

  it("428s a cancel after dispatch, without listing fulfilments", async () => {
    const a = await confirmed("ORD-C3")
    mock.dispatch(a.uuid)
    const e = await caught(client.cancelOrder(a.uuid))
    expect(e.status).toBe(428)
    expect(e.isProblem).toBe(true)
    expect(e.body).not.toHaveProperty("fulfilments")
  })

  it("settles a 202 cancel three ways", async () => {
    const lines = [
      { sku: "9780000000002", quantity: 1 },
      { sku: "US-1", quantity: 1 },
    ]
    const settle = async (n: string, outcome: "cancelled" | "dispatched" | "partial") => {
      const o = await confirmed(n, lines)
      mock.setStatus(o.uuid, "processing")
      await client.cancelOrder(o.uuid)
      const before = mock.state.orders.get(o.uuid).updatedAt
      mock.setUpdatedAt(o.uuid, "2000-01-01T00:00:00Z")
      mock.settleCancel(o.uuid, outcome)
      const after = await client.getOrder(o.uuid)
      expect(after.updatedAt).not.toBe("2000-01-01T00:00:00Z")
      expect(before).toBeTruthy()
      return after
    }
    const c = await settle("ORD-S1", "cancelled")
    expect(c.status).toBe("cancelled")
    expect(c.fulfilments!.map((f) => f.status)).toEqual(["cancelled", "cancelled"])
    const d = await settle("ORD-S2", "dispatched")
    expect(d.status).toBe("complete")
    expect(d.fulfilments!.every((f) => f.status === "dispatched" && f.trackingDetails!.length === 1)).toBe(true)
    const p = await settle("ORD-S3", "partial")
    expect(p.status).toBe("cancelled")
    expect(p.fulfilments!.map((f) => f.status)).toEqual(["dispatched", "cancelled"])
    expect(p.fulfilments![0].trackingDetails).toHaveLength(1)
  })

  it("returns unchanged for the same lines and amended for new ones", async () => {
    const o = await confirmed("ORD-A1")
    const same = await client.amendLines(o.uuid, { orderLines: [{ lineNumber: "item_0", quantity: 1 }] })
    expect(same.amendment.result).toBe("unchanged")
    expect(same.order).toMatchObject({ uuid: o.uuid })
    const added = await client.amendLines(o.uuid, {
      orderLines: [
        { lineNumber: "item_0", quantity: 2 },
        { lineNumber: "item_new", quantity: 1, product: { sku: "POD-1" } },
      ],
    })
    expect(added.amendment.result).toBe("amended")
    expect(added.order!.orderLines).toHaveLength(2)
  })

  it("422s an amend that leaves no lines, with reason no-lines", async () => {
    const o = await confirmed("ORD-A2")
    const e = await caught(client.amendLines(o.uuid, { orderLines: [{ lineNumber: "item_0", quantity: 0 }] }))
    expect(e.status).toBe(422)
    expect((e.body as any).reason).toBe("no-lines")
  })

  it("409s an amend once production has started, with reason and merchantMessage", async () => {
    const o = await confirmed("ORD-A3")
    mock.setStatus(o.uuid, "processing")
    const e = await caught(client.amendLines(o.uuid, { orderLines: [{ lineNumber: "item_0", quantity: 2 }] }))
    expect(e.status).toBe(409)
    expect(e.body).toMatchObject({ reason: "fulfilment-underway", merchantMessage: expect.any(String) })
  })

  it("exposes an injected being-rebuilt refusal", async () => {
    const o = await confirmed("ORD-A4")
    mock.fail(/\/lines$/, 409, {
      type: "about:blank",
      title: "Conflict",
      status: 409,
      detail: "The order is being rebuilt.",
      reason: "being-rebuilt",
      merchantMessage: "Try again shortly.",
    })
    const e = await caught(client.amendLines(o.uuid, { orderLines: [{ lineNumber: "item_0", quantity: 2 }] }))
    expect(e).toBeInstanceOf(PrintTrailApiError)
    expect(e.status).toBe(409)
    expect((e.body as any).reason).toBe("being-rebuilt")
  })
})

describe("mock reset and draft fulfillable status", () => {
  it("reset clears orders, requests, failures and the webhook URL", async () => {
    await client.createOrder(draft("ORD-R1"))
    await client.registerWebhook("https://shop.test/hooks/print-trail")
    mock.state.stock["9780000000002"] = 1
    mock.state.skuStatus["9780000000002"] = "inactive"
    mock.state.createFulfillableStatus = "not-fulfillable"
    mock.fail(/\/token$/, 500, undefined, 5)

    mock.reset()

    expect(mock.state.orders.size).toBe(0)
    expect(mock.state.requests).toEqual([])
    expect(mock.state.webhookUrl).toBeNull()
    expect(mock.state.stock).toEqual({ "9780000000002": 25, "9780000000019": 0, "POD-1": 10000, "US-1": 5 })
    expect(mock.state.skuStatus).toEqual({})
    expect(mock.state.createFulfillableStatus).toBe("fulfillable")
    await expect(client.getToken()).resolves.toMatchObject({ teamCode: "acme" })
    // A once-confirmed order number can be posted again as a new draft.
    const o = await client.createOrder(draft("ORD-R1"))
    await client.confirmOrder(o.uuid, { defaultShippingMethod: "standard" })
    mock.reset()
    await expect(client.createOrder(draft("ORD-R1"))).resolves.toMatchObject({ status: "draft" })
  })

  it("a draft takes createFulfillableStatus", async () => {
    expect(mock.state.createFulfillableStatus).toBe("fulfillable")
    mock.state.createFulfillableStatus = "not-fulfillable"
    const o = await client.createOrder(draft("ORD-F1"))
    expect(o.fulfillableStatus).toBe("not-fulfillable")
    expect(mock.state.orders.get(o.uuid).fulfillableStatus).toBe("not-fulfillable")
  })
})

describe("API 1.1.0 and the legacy mock", () => {
  const raw = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${mock.url}/v1/channels/acme-medusa1${path}`, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }
  const PROBLEMS = "https://docs.printtrail.com/channel-api/problems/"

  it.each([false, true])("register returns the secret (legacy %s)", async (legacy) => {
    mock.state.legacy = legacy
    const res = await raw("POST", "/webhooks", { url: "https://shop.test/hooks/print-trail" })
    expect(res.status).toBe(200)
    if (legacy) expect("secret" in res.body.data.webhookDetail).toBe(false)
    else expect(res.body.data.webhookDetail.secret).toBe("mock-secret")
    // GET never carries it.
    expect("secret" in (await raw("GET", "/")).body.data.webhookDetail).toBe(false)
  })

  it.each([false, true])("rotate returns a new secret the mock signs with (legacy %s)", async (legacy) => {
    mock.state.legacy = legacy
    const res = await raw("POST", "/webhooks/secret/rotate")
    if (legacy) {
      expect(res.status).toBe(404)
      expect(mock.state.webhookSecret).toBe("mock-secret")
      return
    }
    const secret = res.body.data.webhookDetail.secret
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    expect(mock.state.webhookSecret).toBe(secret)
    expect((await raw("POST", "/webhooks", { url: "https://shop.test/x" })).body.data.webhookDetail.secret).toBe(secret)
  })

  it.each([false, true])("confirmedAt is null on a draft, set by confirm, cleared by a full edit (legacy %s)", async (legacy) => {
    mock.state.legacy = legacy
    const o = await client.createOrder(draft("ORD-C1"))
    const confirmed = await client.confirmOrder(o.uuid, { defaultShippingMethod: "standard" })
    const listed = (await raw("GET", "/orders?order-number=ORD-C1")).body.data[0]
    if (legacy) {
      for (const x of [o, confirmed, listed]) expect("confirmedAt" in x).toBe(false)
      return
    }
    expect(o.confirmedAt).toBeNull()
    expect(confirmed.confirmedAt).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(listed.confirmedAt).toBe(confirmed.confirmedAt)
    mock.setStatus(o.uuid, "holding")
    expect((await client.getOrder(o.uuid)).confirmedAt).toBe(confirmed.confirmedAt)
    mock.fullEdit(o.uuid)
    expect((await client.getOrder(o.uuid)).confirmedAt).toBeNull()
  })

  it("webhook payloads carry confirmedAt, except in legacy mode", async () => {
    const seen: string[] = []
    const server = http.createServer((req, res) => {
      let b = ""
      req.on("data", (c) => (b += c))
      req.on("end", () => {
        seen.push(b)
        res.writeHead(202).end()
      })
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    const o = await client.createOrder(draft("ORD-WH1"))
    await mock.sendWebhook("order-status-updated", o.uuid, { url })
    mock.state.legacy = true
    await mock.sendWebhook("order-status-updated", o.uuid, { url })
    await mock.sendWebhook("stock-level-updated", undefined, { url })
    mock.state.legacy = false
    await mock.sendWebhook("stock-level-updated", undefined, { url })
    server.close()
    expect(JSON.parse(seen[0])).toHaveProperty("confirmedAt", null)
    expect("confirmedAt" in JSON.parse(seen[1])).toBe(false)
    expect("confirmedAt" in JSON.parse(seen[2])).toBe(false)
    expect("confirmedAt" in JSON.parse(seen[3])).toBe(false)
  })

  it("a duplicate create of a confirmed order gets the typed 409 with the order", async () => {
    const o = await client.createOrder(draft("ORD-D1"))
    await client.confirmOrder(o.uuid, { defaultShippingMethod: "standard" })
    const res = await raw("POST", "/orders", draft("ORD-D1"))
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      type: `${PROBLEMS}order-already-confirmed`,
      status: 409,
      orderUuid: o.uuid,
      orderStatus: "queued",
      data: { uuid: o.uuid, status: "queued", confirmedAt: expect.any(String) },
    })
    expect(res.body.detail).toMatch(/already been confirmed/)
    // Holding after confirm keeps confirmed_at: still "already confirmed".
    mock.setStatus(o.uuid, "holding")
    expect((await raw("POST", "/orders", draft("ORD-D1"))).body).toMatchObject({
      type: `${PROBLEMS}order-already-confirmed`,
      orderStatus: "holding",
    })
  })

  it.each(["complete", "cancelled", "failed", "returned", "partial"])(
    "a confirmed order that has since finished (%s) is not updatable (API 1.1.1)",
    async (status) => {
      const o = await client.createOrder(draft("ORD-D4"))
      await client.confirmOrder(o.uuid, { defaultShippingMethod: "standard" })
      mock.setStatus(o.uuid, status)
      const res = await raw("POST", "/orders", draft("ORD-D4"))
      expect(res.status).toBe(409)
      // The type no longer says it was confirmed; data still does.
      expect(res.body).toMatchObject({
        type: `${PROBLEMS}order-not-updatable`,
        orderUuid: o.uuid,
        orderStatus: status,
        data: { uuid: o.uuid, status, confirmedAt: expect.any(String) },
      })
      expect(res.body.detail).toMatch(/can no longer be updated/)
    }
  )

  it("a never-confirmed order past replacing is not updatable", async () => {
    const o = await client.createOrder(draft("ORD-D2"))
    mock.setStatus(o.uuid, "complete")
    const res = await raw("POST", "/orders", draft("ORD-D2"))
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      type: `${PROBLEMS}order-not-updatable`,
      orderUuid: o.uuid,
      orderStatus: "complete",
      data: { uuid: o.uuid, confirmedAt: null },
    })
    expect(res.body.detail).toMatch(/can no longer be updated/)
  })

  it("legacy: a duplicate create gets the generic problem with no order", async () => {
    mock.state.legacy = true
    const o = await client.createOrder(draft("ORD-D3"))
    await client.confirmOrder(o.uuid, { defaultShippingMethod: "standard" })
    const res = await raw("POST", "/orders", draft("ORD-D3"))
    expect(res.status).toBe(409)
    expect(res.body.type).toBe("about:blank")
    for (const k of ["orderUuid", "orderStatus", "data"]) expect(k in res.body).toBe(false)
  })

  const held = (uuid: string) => {
    const o = mock.state.orders.get(uuid)
    Object.assign(o, { status: "holding", fulfillableFrom: null })
    o.fulfilments.forEach((f: any) => (f.status = "draft"))
  }

  it("legacy: a confirmed order held after its countdown cleared can be re-posted (the old ambiguity)", async () => {
    mock.state.legacy = true
    const o = await client.createOrder(draft("ORD-D4"))
    await client.confirmOrder(o.uuid, { defaultShippingMethod: "standard" })
    // Held with nothing sent (Print Trail's own example of an unprovable order).
    held(o.uuid)
    expect((await raw("POST", "/orders", draft("ORD-D4"))).status).toBe(201)
    mock.state.legacy = false
    const p = await client.createOrder(draft("ORD-D5"))
    await client.confirmOrder(p.uuid, { defaultShippingMethod: "standard" })
    held(p.uuid)
    expect((await raw("POST", "/orders", draft("ORD-D5"))).status).toBe(409)
  })

  it.each([false, true])("a pre-order SKU gives a draft Print Trail can't fulfil (legacy %s)", async (legacy) => {
    mock.state.legacy = legacy
    // Before API 1.3.0; from it, these are held instead.
    mock.state.preOrderRelease = false
    mock.state.skuStatus["POD-1"] = "pre-order"
    const o = await client.createOrder(
      draft("ORD-P1", [
        { sku: "POD-1", quantity: 1 },
        { sku: "9780000000002", quantity: 1 },
      ])
    )
    expect(o).toMatchObject({ status: "draft", fulfillableStatus: "not-fulfillable", fulfilments: [] })
    expect(o.errors).toContainEqual({ code: "product_preorder", key: "product", message: "Product POD-1 is on pre-order" })
    expect(o.orderLines).toHaveLength(2)
    const err = await caught(client.confirmOrder(o.uuid, { defaultShippingMethod: "standard" }))
    expect(err.status).toBe(428)
  })

  it("reset restores the mode and the secret", async () => {
    await raw("POST", "/webhooks/secret/rotate")
    mock.state.legacy = true
    mock.reset()
    expect(mock.state.legacy).toBe(false)
    expect(mock.state.webhookSecret).toBe("mock-secret")
  })
})

// API 1.3.0: pre-orders are accepted and held, then released.
describe("API 1.3.0 pre-orders (mock preOrderRelease)", () => {
  const P = "PRE-1"
  const Q = "PRE-2"
  const S = "9780000000002"
  const Z = "9780000000019"
  let server: http.Server
  let received: any[]
  let hookUrl: string

  const raw = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${mock.url}/v1/channels/acme-medusa1${path}`, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null }
  }
  const order = (n: string, lines: { sku: string; quantity: number }[]) => client.createOrder(draft(n, lines))
  const confirm = (uuid: string) => client.confirmOrder(uuid, { defaultShippingMethod: "standard" })
  const placed = async (n: string, lines: { sku: string; quantity: number }[]) => confirm((await order(n, lines)).uuid)
  const fulfilmentWith = (o: any, sku: string) =>
    o.fulfilments.find((f: any) => f.orderLines.some((l: any) => l.product.sku === sku))
  const types = () => received.map((r) => r.notificationType)

  beforeEach(async () => {
    await mock.close()
    mock = await startMockPrintTrail({
      token: TOKEN,
      channelId: "acme-medusa1",
      skus: { [S]: 25, [Z]: 0, [P]: 0, [Q]: 0, "POD-1": 10000 },
      skuStatus: { [P]: "pre-order", [Q]: "pre-order" },
      publicationDate: { [P]: "2026-12-01" },
    })
    client = new PrintTrailClient({ baseUrl: mock.url, channelId: "acme-medusa1", apiToken: TOKEN, retryDelays: [0] })
    received = []
    server = http.createServer(async (req, res) => {
      let b = ""
      for await (const chunk of req) b += chunk
      received.push(JSON.parse(b))
      res.writeHead(202).end()
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
    hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks/print-trail`
    await client.registerWebhook(hookUrl)
  })

  afterEach(() => new Promise<void>((r) => server.close(() => r())))

  it("defaults: on unless legacy; off is today's draft", async () => {
    expect(mock.state.preOrderRelease).toBe(true)
    mock.state.legacy = true
    expect(mock.state.preOrderRelease).toBe(false)
    mock.state.legacy = false
    mock.state.preOrderRelease = false
    expect(mock.state.preOrderRelease).toBe(false)
    mock.reset()
    expect(mock.state.preOrderRelease).toBe(true)
  })

  it("pre-order lines get their own back-order fulfilment", async () => {
    const o = await order("ORD-PO1", [{ sku: P, quantity: 1 }, { sku: S, quantity: 1 }])
    expect(o.fulfillableStatus).toBe("fulfillable")
    expect(o.errors).toEqual([])
    expect(o.fulfilments).toHaveLength(2)
    expect(fulfilmentWith(o, P)).toMatchObject({ status: "back-order", backOrderReason: "pre-order", sentToWarehouseAt: null })
    const c = await confirm(o.uuid)
    expect(c.status).toBe("queued")
    expect(fulfilmentWith(c, P)).toMatchObject({ status: "back-order", backOrderReason: "pre-order" })
    expect(fulfilmentWith(c, S)).toMatchObject({ status: "processing", backOrderReason: null, sentToWarehouseAt: null })
  })

  it("an order of only pre-order lines confirms queued, then waits as back-order", async () => {
    const c = await placed("ORD-PO2", [{ sku: P, quantity: 1 }])
    expect(c.status).toBe("queued")
    expect(c.fulfilments).toEqual([expect.objectContaining({ status: "back-order", backOrderReason: "pre-order" })])
    // Print Trail's countdown ends (the mock has none).
    mock.setStatus(c.uuid, "back-order")
    expect((await client.getOrder(c.uuid)).fulfilments![0]).toMatchObject({ status: "back-order", backOrderReason: "pre-order" })
  })

  it("a waiting draft can be re-posted (it's still replaceable)", async () => {
    await order("ORD-PO3", [{ sku: P, quantity: 1 }])
    expect((await raw("POST", "/orders", draft("ORD-PO3", [{ sku: P, quantity: 2 }]))).status).toBe(201)
  })

  it("release on status change fires the status webhooks", async () => {
    const c = await placed("ORD-PO4", [{ sku: P, quantity: 1 }])
    mock.setStatus(c.uuid, "back-order")
    mock.state.stock[P] = 5
    await mock.setSkuStatus(P, "active")
    const o = await client.getOrder(c.uuid)
    expect(o.fulfilments![0]).toMatchObject({ status: "draft", backOrderReason: null, sentToWarehouseAt: null })
    expect(o.status).toBe("queued")
    expect(types()).toEqual(["fulfilment-status-updated", "order-status-updated", "stock-level-updated"])
    expect(received[0]).toMatchObject({
      orderUuid: c.uuid,
      originalFulfilmentStatus: "back-order",
      currentFulfilmentStatus: "draft",
      backOrderReason: null,
      sentToWarehouseAt: null,
      products: [P],
    })
    expect(received[1]).toMatchObject({ originalOrderStatus: "back-order", currentOrderStatus: "queued" })
    // Print Trail: released back to draft with confirmedAt kept, then on to the
    // warehouse at the countdown's end.
    expect(o.confirmedAt).toBe(c.confirmedAt)
    mock.sendToWarehouse(c.uuid, 0)
    expect((await client.getOrder(c.uuid)).fulfilments![0]).toMatchObject({ status: "processing", sentToWarehouseAt: expect.any(String) })
  })

  it("going live without stock switches the reason to out-of-stock", async () => {
    const c = await placed("ORD-PO5", [{ sku: P, quantity: 1 }])
    await mock.setSkuStatus(P, "active")
    const o = await client.getOrder(c.uuid)
    expect(o.fulfilments![0]).toMatchObject({ status: "back-order", backOrderReason: "out-of-stock" })
  })

  it("activation without stock: stock event only, updatedAt moves", async () => {
    const c = await placed("ORD-PO6", [{ sku: P, quantity: 1 }])
    mock.setUpdatedAt(c.uuid, "2026-01-01T00:00:00Z")
    await mock.setSkuStatus(P, "active")
    expect(types()).toEqual(["stock-level-updated"])
    expect(received[0].products).toEqual([
      expect.objectContaining({ sku: P, status: "active", stock: 0, publicationDate: "2026-12-01" }),
    ])
    const o = await client.getOrder(c.uuid)
    expect(o.fulfilments![0].backOrderReason).toBe("out-of-stock")
    expect(o.updatedAt! > "2026-01-01T00:00:00Z").toBe(true)
  })

  it("stock arriving while still pre-order releases nothing", async () => {
    const c = await placed("ORD-PO7", [{ sku: P, quantity: 1 }])
    await mock.restock(P, 10)
    expect(types()).toEqual(["stock-level-updated"])
    expect((await client.getOrder(c.uuid)).fulfilments![0].backOrderReason).toBe("pre-order")
  })

  // Only active releases.
  it("an inactive product releases nothing and its waiting orders stay pre-order", async () => {
    const c = await placed("ORD-PO30", [{ sku: P, quantity: 1 }])
    mock.state.stock[P] = 5
    await mock.setSkuStatus(P, "inactive")
    expect(types()).toEqual(["stock-level-updated"])
    expect(received[0].products).toEqual([expect.objectContaining({ sku: P, status: "inactive" })])
    const o = await client.getOrder(c.uuid)
    expect(o.fulfilments![0]).toMatchObject({ status: "back-order", backOrderReason: "pre-order" })
    expect(o.orderLines![0].product).toMatchObject({ activeState: "inactive" })
    await mock.restock(P, 6)
    expect((await client.getOrder(c.uuid)).fulfilments![0]).toMatchObject({ status: "back-order", backOrderReason: "pre-order" })
    // Then active: released.
    await mock.setSkuStatus(P, "active")
    expect((await client.getOrder(c.uuid)).fulfilments![0]).toMatchObject({ status: "draft", backOrderReason: null })
  })

  // No fulfilment webhook and no updatedAt change, only stock-level-updated.
  it("an out-of-stock back-order whose product goes back on pre-order or inactive waits as pre-order", async () => {
    const c = await placed("ORD-PO31", [{ sku: P, quantity: 1 }])
    await mock.setSkuStatus(P, "active")
    expect((await client.getOrder(c.uuid)).fulfilments![0].backOrderReason).toBe("out-of-stock")
    mock.setUpdatedAt(c.uuid, "2026-01-01T00:00:00Z")
    received = []
    await mock.setSkuStatus(P, "pre-order")
    expect(types()).toEqual(["stock-level-updated"])
    const o = await client.getOrder(c.uuid)
    expect(o.fulfilments![0]).toMatchObject({ status: "back-order", backOrderReason: "pre-order" })
    expect(o.updatedAt).toBe("2026-01-01T00:00:00Z")
    // Stock no longer releases it.
    await mock.restock(P, 5)
    expect((await client.getOrder(c.uuid)).fulfilments![0]).toMatchObject({ status: "back-order", backOrderReason: "pre-order" })

    // An active product held out of stock by a back-order warehouse, then
    // set inactive.
    mock.state.backorderWarehouse = true
    const z = await placed("ORD-PO32", [{ sku: Z, quantity: 1 }])
    expect(z.fulfilments![0].backOrderReason).toBe("out-of-stock")
    await mock.setSkuStatus(Z, "inactive")
    expect((await client.getOrder(z.uuid)).fulfilments![0]).toMatchObject({ status: "back-order", backOrderReason: "pre-order" })
  })

  it("an unconfirmed draft's waiting fulfilment is released to draft and the order stays a draft", async () => {
    const o = await order("ORD-PO33", [{ sku: P, quantity: 1 }])
    const c = await placed("ORD-PO34", [{ sku: P, quantity: 1 }])
    mock.state.stock[P] = 1
    await mock.setSkuStatus(P, "active")
    const d = await client.getOrder(o.uuid)
    expect(d.status).toBe("draft")
    expect(d.confirmedAt).toBeNull()
    expect(d.fulfilments![0]).toMatchObject({ status: "draft", backOrderReason: null, sentToWarehouseAt: null })
    // The older draft holds no stock, so the confirmed order still gets the one.
    expect((await client.getOrder(c.uuid)).fulfilments![0]).toMatchObject({ status: "draft", backOrderReason: null })
  })

  it("restock releases oldest first while stock lasts", async () => {
    const a = await placed("ORD-PO8", [{ sku: P, quantity: 2 }])
    const b = await placed("ORD-PO9", [{ sku: P, quantity: 2 }])
    await mock.setSkuStatus(P, "active")
    mock.setUpdatedAt(b.uuid, "2026-01-01T00:00:00Z")
    received = []
    await mock.restock(P, 3)
    expect((await client.getOrder(a.uuid)).fulfilments![0].status).toBe("draft")
    const newer = await client.getOrder(b.uuid)
    expect(newer.fulfilments![0]).toMatchObject({ status: "back-order", backOrderReason: "out-of-stock" })
    expect(newer.updatedAt).toBe("2026-01-01T00:00:00Z")
    expect(received.filter((r) => r.orderUuid === b.uuid)).toEqual([])
    // Both are queued (no countdown), so no order status changes.
    expect(types()).toEqual(["fulfilment-status-updated", "stock-level-updated"])
  })

  it("a mixed order is processing once its waiting part is released", async () => {
    const c = await placed("ORD-PO10", [{ sku: S, quantity: 1 }, { sku: P, quantity: 1 }])
    const inStock = c.fulfilments!.findIndex((f) => f.status === "processing")
    mock.sendToWarehouse(c.uuid, inStock)
    expect((await client.getOrder(c.uuid)).status).toBe("processing")
    mock.state.stock[P] = 1
    received = []
    await mock.setSkuStatus(P, "active")
    const o = await client.getOrder(c.uuid)
    expect(o.status).toBe("processing")
    expect(fulfilmentWith(o, P)).toMatchObject({ status: "processing", backOrderReason: null, sentToWarehouseAt: expect.any(String) })
    // The order's status didn't change, so only the fulfilment event.
    expect(types()).toEqual(["fulfilment-status-updated", "stock-level-updated"])
  })

  it("going active sends stock-level-updated with status and publicationDate", async () => {
    await mock.setSkuStatus(P, "active", "2026-11-11")
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ notificationType: "stock-level-updated" })
    expect(received[0].products).toEqual([
      { sku: P, productUuid: `prod-${P}`, stock: 0, status: "active", publicationDate: "2026-11-11", preOrderLimit: null, preOrderRemaining: null },
    ])
  })

  const amend = (uuid: string, lines: { lineNumber: string; quantity: number }[]) =>
    raw("PUT", `/orders/${uuid}/lines`, { orderLines: lines })

  it("an order is amendable until anything is sent", async () => {
    const c = await placed("ORD-PO11", [{ sku: P, quantity: 1 }])
    const ok = await amend(c.uuid, [{ lineNumber: "item_0", quantity: 2 }])
    expect(ok.status).toBe(200)
    expect(ok.body.data.fulfilments[0]).toMatchObject({ status: "back-order", backOrderReason: "pre-order" })
    expect(ok.body.data.status).toBe("queued")
    // Released but not sent: Print Trail re-queues it, still amendable.
    mock.state.stock[P] = 5
    await mock.setSkuStatus(P, "active")
    expect((await amend(c.uuid, [{ lineNumber: "item_0", quantity: 1 }])).status).toBe(200)
    mock.sendToWarehouse(c.uuid, 0)
    const refused = await amend(c.uuid, [{ lineNumber: "item_0", quantity: 3 }])
    expect(refused.status).toBe(409)
    expect(refused.body.reason).toBe("fulfilment-underway")
  })

  it("a held out-of-stock back-order is amendable", async () => {
    mock.state.backorderWarehouse = true
    const c = await placed("ORD-PO12", [{ sku: Z, quantity: 1 }])
    expect(c.fulfilments![0]).toMatchObject({ status: "back-order", backOrderReason: "out-of-stock" })
    expect((await amend(c.uuid, [{ lineNumber: "item_0", quantity: 2 }])).status).toBe(200)
  })

  it("held fulfilments have no sentToWarehouseAt; dispatch and sendToWarehouse set it", async () => {
    const c = await placed("ORD-PO13", [{ sku: S, quantity: 1 }, { sku: "POD-1", quantity: 1 }])
    expect(c.fulfilments!.map((f) => f.sentToWarehouseAt)).toEqual([null])
    const d = await placed("ORD-PO14", [{ sku: S, quantity: 1 }])
    mock.dispatch(d.uuid, 0)
    expect((await client.getOrder(d.uuid)).fulfilments![0].sentToWarehouseAt).toEqual(expect.any(String))
    mock.sendToWarehouse(c.uuid, 0)
    expect((await client.getOrder(c.uuid)).fulfilments![0].sentToWarehouseAt).toEqual(expect.any(String))
  })

  it("a warehouse back-order is reason warehouse, refused for amend and cancelled with 202", async () => {
    const c = await placed("ORD-PO15", [{ sku: S, quantity: 1 }])
    mock.sendToWarehouse(c.uuid, 0, { backOrder: true })
    const o = await client.getOrder(c.uuid)
    expect(o.fulfilments![0]).toMatchObject({ status: "back-order", backOrderReason: "warehouse", sentToWarehouseAt: expect.any(String) })
    expect((await amend(c.uuid, [{ lineNumber: "item_0", quantity: 2 }])).body.reason).toBe("fulfilment-underway")
    expect((await client.cancelOrder(c.uuid)).status).toBe(202)
  })

  it("a waiting order cancels with 200; once anything is sent, 202", async () => {
    const a = await placed("ORD-PO16", [{ sku: P, quantity: 1 }])
    await expect(client.cancelOrder(a.uuid)).resolves.toMatchObject({ status: 200, order: { status: "cancelled" } })
    const b = await placed("ORD-PO17", [{ sku: S, quantity: 1 }, { sku: P, quantity: 1 }])
    await expect(client.cancelOrder(b.uuid)).resolves.toMatchObject({ status: 200 })
    const c = await placed("ORD-PO18", [{ sku: S, quantity: 1 }, { sku: P, quantity: 1 }])
    mock.sendToWarehouse(c.uuid, c.fulfilments!.findIndex((f) => f.status === "processing"))
    await expect(client.cancelOrder(c.uuid)).resolves.toMatchObject({ status: 202 })
  })

  it("a backorder warehouse turns a confirm shortfall into an out-of-stock back-order", async () => {
    const o = await order("ORD-PO19", [{ sku: Z, quantity: 1 }])
    expect((await raw("PUT", `/orders/${o.uuid}/confirm`, {})).status).toBe(409)
    mock.state.backorderWarehouse = true
    const res = await raw("PUT", `/orders/${o.uuid}/confirm`, {})
    expect(res.status).toBe(202)
    expect(res.body.data.status).toBe("queued")
    expect(res.body.data.fulfilments[0]).toMatchObject({ status: "back-order", backOrderReason: "out-of-stock", sentToWarehouseAt: null })
    // Released when stock arrives.
    await mock.restock(Z, 4)
    expect((await client.getOrder(o.uuid)).fulfilments![0].status).toBe("draft")
  })

  it("pre-order limits: unlimited, limited and active", async () => {
    mock.state.preOrderLimit = { [Q]: 5, [S]: 9 }
    mock.state.stock[Q] = 3
    const row = async (sku: string) => (await client.stockLevels()).find((l) => l.sku === sku)
    expect(await row(P)).toEqual({ sku: P, stock: 0, status: "pre-order", publicationDate: "2026-12-01", preOrderLimit: null, preOrderRemaining: null })
    expect(await row(Q)).toMatchObject({ stock: 5, preOrderLimit: 5, preOrderRemaining: 5 })
    await placed("ORD-PO20", [{ sku: Q, quantity: 2 }])
    expect(await row(Q)).toMatchObject({ stock: 3, preOrderLimit: 5, preOrderRemaining: 3 })
    // Not on pre-order: the limit doesn't apply (Print Trail sends null).
    expect(await row(S)).toMatchObject({ stock: 25, status: "active", preOrderLimit: null, preOrderRemaining: null })
  })

  it("a confirm or cancel that changes what remains of a limit sends stock-level-updated", async () => {
    mock.state.preOrderLimit = { [Q]: 5 }
    const c = await placed("ORD-PO28", [{ sku: Q, quantity: 2 }])
    const items = async (n: number) => {
      await new Promise((r) => setTimeout(r, 50))
      return received.filter((r) => r.notificationType === "stock-level-updated").slice(n).flatMap((r) => r.products)
    }
    expect(await items(0)).toEqual([expect.objectContaining({ sku: Q, stock: 3, preOrderRemaining: 3 })])
    await client.cancelOrder(c.uuid)
    expect(await items(1)).toEqual([expect.objectContaining({ sku: Q, stock: 5, preOrderRemaining: 5 })])
    // An unlimited pre-order sends nothing.
    await placed("ORD-PO29", [{ sku: P, quantity: 1 }])
    expect(await items(2)).toEqual([])
  })

  // Print Trail's amend refused for stock (409 stock-held).
  it("an amend over a pre-order limit is Print Trail's stock-held 409; one within it sends stock-level-updated", async () => {
    mock.state.preOrderLimit = { [Q]: 3 }
    const c = await placed("ORD-PO35", [{ sku: Q, quantity: 2 }])
    const settled = async () => {
      await new Promise((r) => setTimeout(r, 50))
      return received.filter((r) => r.notificationType === "stock-level-updated").flatMap((r) => r.products)
    }
    await settled()
    received = []
    // The order's own 2 come back in the rebuild: 1 remains, so 3 is available.
    const refused = await amend(c.uuid, [{ lineNumber: "item_0", quantity: 4 }])
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({
      reason: "stock-held",
      merchantMessage: expect.stringContaining(Q),
      message: "Stock unavailable for one or more items",
      errors: [{ sku: Q, requested: 4, available: 3 }],
    })
    expect((await client.getOrder(c.uuid)).orderLines![0].quantity).toBe(2)
    expect(await settled()).toEqual([])
    const ok = await amend(c.uuid, [{ lineNumber: "item_0", quantity: 3 }])
    expect(ok.status).toBe(200)
    expect(await settled()).toEqual([expect.objectContaining({ sku: Q, stock: 0, preOrderRemaining: 0 })])
    // An unchanged amend sends nothing.
    received = []
    expect((await amend(c.uuid, [{ lineNumber: "item_0", quantity: 3 }])).body.amendment.result).toBe("unchanged")
    expect(await settled()).toEqual([])
  })

  it("confirming over the limit is a 409 with available = remaining", async () => {
    mock.state.preOrderLimit = { [Q]: 2 }
    await placed("ORD-PO21", [{ sku: Q, quantity: 2 }])
    const o = await order("ORD-PO22", [{ sku: Q, quantity: 1 }])
    const res = await raw("PUT", `/orders/${o.uuid}/confirm`, {})
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ message: "Stock unavailable for one or more items", errors: [{ sku: Q, requested: 1, available: 0 }] })
    const reserved = await raw("POST", "/orders", { ...draft("ORD-PO23", [{ sku: Q, quantity: 1 }]), reserve: true })
    expect(reserved.status).toBe(409)
  })

  it("stock levels carry status and publicationDate", async () => {
    const levels = await client.stockLevels()
    expect(levels).toContainEqual(expect.objectContaining({ sku: P, status: "pre-order", publicationDate: "2026-12-01" }))
    expect(levels).toContainEqual(expect.objectContaining({ sku: S, status: "active", publicationDate: null }))
  })

  it("lines carry activeState and publicationDate", async () => {
    const o = await order("ORD-PO24", [{ sku: P, quantity: 1 }, { sku: S, quantity: 1 }])
    expect(o.orderLines!.map((l) => l.product)).toEqual([
      expect.objectContaining({ sku: P, activeState: "pre-order", publicationDate: "2026-12-01" }),
      expect.objectContaining({ sku: S, activeState: "active", publicationDate: null }),
    ])
    expect(fulfilmentWith(o, P).orderLines[0].product.activeState).toBe("pre-order")
  })

  it("responses carry the API version header (none in legacy)", async () => {
    // Pre-orders are API 1.3.0 (on production); without them,
    // the 1.2.0 security release.
    expect((await raw("GET", "/")).headers.get("print-trail-api-version")).toBe("1.3.0")
    expect((await raw("GET", "/orders/nope")).headers.get("print-trail-api-version")).toBe("1.3.0")
    mock.state.preOrderRelease = false
    expect((await raw("GET", "/")).headers.get("print-trail-api-version")).toBe("1.2.0")
    mock.state.apiVersion = "1.1.1"
    expect((await raw("GET", "/")).headers.get("print-trail-api-version")).toBe("1.1.1")
    mock.reset()
    mock.state.legacy = true
    expect((await raw("GET", "/")).headers.has("print-trail-api-version")).toBe(false)
  })

  it("the control route sets status and stock", async () => {
    const c = await placed("ORD-PO25", [{ sku: P, quantity: 1 }])
    received = []
    const res = await fetch(`${mock.url}/__mock/products/${P}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active", stock: 2, publicationDate: "2026-10-01" }),
    })
    expect(res.status).toBe(200)
    expect(mock.state.stock[P]).toBe(2)
    expect(mock.state.skuStatus[P]).toBe("active")
    expect((await client.getOrder(c.uuid)).fulfilments![0].status).toBe("draft")
    expect(types().filter((t) => t === "stock-level-updated")).toHaveLength(1)
  })

  it("preOrderRelease off is today's draft and today's shapes", async () => {
    mock.state.preOrderRelease = false
    const o = await order("ORD-PO26", [{ sku: P, quantity: 1 }])
    expect(o).toMatchObject({ fulfillableStatus: "not-fulfillable", fulfilments: [] })
    expect(o.errors).toContainEqual(expect.objectContaining({ code: "product_preorder" }))
    expect("activeState" in o.orderLines![0].product!).toBe(false)
    expect(await client.stockLevels()).toContainEqual({ sku: S, stock: 25 })
    const s = await placed("ORD-PO27", [{ sku: S, quantity: 1 }])
    expect("backOrderReason" in s.fulfilments![0]).toBe(false)
    expect("sentToWarehouseAt" in s.fulfilments![0]).toBe(false)
  })
})
