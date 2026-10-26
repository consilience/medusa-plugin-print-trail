// Manual smoke test against Print Trail staging (the staging.yml workflow).
// It runs the plugin's client and send steps with an in-memory store; it
// doesn't boot Medusa, since a CI runner can't receive Print Trail webhooks.
//
// Needs PT_STAGING_BASE_URL, PT_STAGING_CHANNEL_ID, PT_STAGING_API_TOKEN and
// PT_STAGING_SKUS (comma-separated SKUs the staging channel can order). With none
// of them set the suite is skipped; with any set, all are required and the base
// URL must pass assertStagingTarget. Every order is numbered CI-<run id>-<n> and
// cancelled at the end. Logs counts only: no tokens, no order bodies.
import { resolvePluginOptions } from "../../src/config"
import { preparePayload } from "../../src/lib/hooks"
import type { GraphOrder, SelectedLine } from "../../src/lib/lines"
import { printTrailOrderNumber } from "../../src/lib/order-number"
import { checkGate, confirm, createDraft, recordOutcome, type SendContext } from "../../src/lib/send-flow"
import { MemoryStore } from "../../src/lib/__tests__/flow-fixtures"
import { PrintTrailClient } from "../../src/modules/printTrail/client/client"
import { PrintTrailApiError } from "../../src/modules/printTrail/client/errors"
import { assertStagingTarget } from "./guard"

const env = process.env
const vars = ["PT_STAGING_BASE_URL", "PT_STAGING_CHANNEL_ID", "PT_STAGING_API_TOKEN", "PT_STAGING_SKUS"] as const
const anySet = vars.some((v) => env[v])

jest.setTimeout(300_000)

// Checked before any test or request: a bad host fails the run at once.
function loadConfig() {
  const base = assertStagingTarget(env.PT_STAGING_BASE_URL)
  const missing = vars.filter((v) => !env[v])
  if (missing.length) {
    // eslint-disable-next-line @medusajs/use-medusa-error-not-generic-error
    throw new Error(`staging smoke: ${missing.join(", ")} not set`)
  }
  return {
    baseUrl: base.origin,
    channelId: env.PT_STAGING_CHANNEL_ID!,
    apiToken: env.PT_STAGING_API_TOKEN!,
    skus: env.PT_STAGING_SKUS!.split(",").map((s) => s.trim()).filter(Boolean),
    runId: env.CI_RUN_ID || `local${Date.now()}`,
  }
}
const config = anySet ? loadConfig() : null

;(config ? describe : describe.skip)("Print Trail staging smoke", () => {
  if (!config) {
    it("needs the PT_STAGING_* variables", () => undefined)
    return
  }
  const { baseUrl, channelId, apiToken, skus, runId } = config
  const prefix = `CI-${runId}-`

  const client = new PrintTrailClient({ baseUrl, channelId, apiToken })
  const store = new MemoryStore()
  const ctx: SendContext = {
    store,
    client,
    options: resolvePluginOptions({ baseUrl, channelId, apiToken, orderNumberPrefix: prefix }),
  }
  const created = new Set<string>()
  let n = 0

  const order = (): GraphOrder => {
    n += 1
    return {
      id: `order_ci_${n}`,
      display_id: n,
      email: "ci@example.com",
      status: "pending",
      canceled_at: null,
      shipping_address: {
        first_name: "Test",
        last_name: "Order",
        address_1: "1 Test Street",
        city: "London",
        postal_code: "N1 1AA",
        country_code: "gb",
      },
      billing_address: null,
      payment_collections: [{ captured_amount: 0, refunded_amount: 0 }],
    } as GraphOrder
  }

  // The workflow's payload, create, gate, confirm and record steps.
  const sendOne = async () => {
    const o = order()
    const lines: SelectedLine[] = [{ lineItemId: `item_ci_${n}`, sku: skus[0], quantity: 1, method: "standard" }]
    const orderNumber = printTrailOrderNumber(prefix, o.display_id, 1)
    const prepared = preparePayload({ order: o, lines, orderNumber, options: ctx.options })
    const create = await createDraft(ctx, { order: o, lines, sequence: 1, orderNumber, prepared })
    if (create.pt?.uuid) created.add(create.pt.uuid)
    const gate = await checkGate(ctx, o, create)
    const confirmed =
      gate.ok && create.rowId && create.pt
        ? await confirm(ctx, { rowId: create.rowId, pt: create.pt, body: gate.body!, methodByLine: create.methodByLine })
        : null
    await recordOutcome(ctx, { orderId: o.id, create, gate, confirm: confirmed })
    const row = store.rows.find((r) => r.id === create.rowId)
    if (row?.pt_uuid) created.add(row.pt_uuid)
    return { orderNumber, row, create, confirmed }
  }

  const cancelAll = async () => {
    let cancelled = 0
    let failed = 0
    for (const uuid of created) {
      try {
        const current = await client.getOrder(uuid)
        if (current.status !== "cancelled") await client.cancelOrder(uuid)
        cancelled++
      } catch {
        failed++
      }
    }
    // eslint-disable-next-line no-console
    console.log(`staging smoke cleanup: ${created.size} created, ${cancelled} cancelled or already cancelled, ${failed} failed`)
  }

  afterAll(cancelAll)

  it("reads the token, channel and shipping methods", async () => {
    const token = await client.getToken()
    expect(token.teamCode).toEqual(expect.any(String))
    expect(token.teamCode.length).toBeGreaterThan(0)
    expect(token.channelId).toBe(channelId)
    const channel = await client.getChannel()
    expect(channel.code).toBe(token.channelCode)
    const methods = await client.listShippingMethods()
    expect(methods.length).toBeGreaterThan(0)
    for (const m of methods) expect(["standard", "express", "air", "tracked"]).toContain(m.code)
  })

  it("validates the SKUs", async () => {
    const result = await client.validateSkus(skus)
    expect(result.results.map((r) => [r.sku, r.state])).toEqual(skus.map((s) => [s, "matched"]))
  })

  it("creates, confirms and cancels an order", async () => {
    const { row, confirmed } = await sendOne()
    expect(confirmed?.outcome).toBe("confirmed")
    expect(row?.confirmed_at).toBeTruthy()
    const { status } = await client.cancelOrder(row!.pt_uuid!)
    expect([200, 202]).toContain(status)
  })

  it("answers a re-post of a confirmed order with 409", async () => {
    const { orderNumber, row, confirmed } = await sendOne()
    expect(confirmed?.outcome).toBe("confirmed")
    let error: unknown
    try {
      const again = await client.createOrder({
        orderNumber,
        strictSkus: true,
        orderLines: [{ quantity: 1, lineNumber: `item_ci_${n}`, product: { sku: skus[0] } }],
      })
      created.add(again.uuid)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(PrintTrailApiError)
    expect((error as PrintTrailApiError).status).toBe(409)
    expect(row?.pt_uuid).toBeTruthy()
  })

  it("lists orders updated since an hour ago", async () => {
    const since = new Date(Date.now() - 3600_000).toISOString()
    let pages = 0
    let orders = 0
    for await (const page of client.ordersUpdatedSincePages(since)) {
      pages++
      orders += page.length
      if (pages > 100) break
    }
    // The walk stops when links.next is null (or would leave the host).
    expect(pages).toBeGreaterThan(0)
    expect(pages).toBeLessThanOrEqual(100)
    expect(orders).toBeGreaterThanOrEqual(created.size > 0 ? 1 : 0)
  })

  // Runs last: everything this run created is cancelled, or cancelling (202).
  it("cancels everything it created", async () => {
    await cancelAll()
    for (const uuid of created) {
      const o = await client.getOrder(uuid)
      expect(["cancelled", "processing"]).toContain(o.status)
    }
  })
})
