import path from "node:path"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { DEFAULT_RETRY_DELAYS_MS } from "../../src/modules/printTrail/client/client"
import { HARNESS, SKUS, useMock } from "./harness"
import { adminHeaders, removeItem, type Headers } from "./helpers/admin"
import { runJob } from "./helpers/jobs"
import {
  CONFIRMS,
  dismissLink,
  linkExists,
  POSTS,
  printTrail,
  ptOrders,
  requests,
  rowFor,
  updateRow,
} from "./helpers/rows"
import { seedStore, type Seed } from "./helpers/seed"
import { backdateOrder, createOrderDirect, orderItems, placeOrder } from "./helpers/store"
import { waitFor } from "./helpers/wait"

jest.setTimeout(120_000)

const mock = useMock()
const LOOKBACK_DAYS = 7
const past = () => new Date(Date.now() - 60_000)

medusaIntegrationTestRunner({
  cwd: path.join(__dirname, "app"),
  testSuite: ({ api, getContainer, dbConnection, utils }) => {
    let seed: Seed
    let admin: Headers
    const container = () => getContainer()
    const sweep = () => runJob(container(), "print-trail-sweep", utils.waitWorkflowExecutions)
    const confirmedRow = (orderId: string, what = "a confirmed row") =>
      waitFor(async () => {
        const row = await rowFor(container(), orderId)
        return row?.confirmed_at ? row : undefined
      }, { what })

    beforeAll(async () => {
      seed = await seedStore(container())
      admin = await adminHeaders(container())
    })

    it("sends only the Print Trail lines of a mixed basket", async () => {
      const { orderId, displayId } = await placeOrder(api, seed, [
        { variantId: seed.variants.pt, quantity: 2 },
        { variantId: seed.variants.plain, quantity: 1 },
      ])
      const row = await confirmedRow(orderId)
      const [pt] = ptOrders(mock(), `${HARNESS.prefix}${displayId}`)
      expect(pt.orderLines).toHaveLength(1)
      expect(pt.orderLines[0]).toMatchObject({ quantity: 2, product: { sku: SKUS.pt } })
      expect(row.pt_order_number).toBe(`${HARNESS.prefix}${displayId}`)
      await expect(linkExists(container(), row.id, orderId)).resolves.toBe(true)
    })

    it("blocks an unknown SKU and never confirms", async () => {
      const { orderId } = await placeOrder(api, seed, [{ variantId: seed.variants.unknownSku, quantity: 1 }])
      const row = await waitFor(async () => {
        const r = await rowFor(container(), orderId)
        return r?.attention === "unmatched-skus" ? r : undefined
      }, { what: "unmatched-skus" })
      expect(row.confirmed_at).toBeNull()
      const posts = requests(mock(), "POST", POSTS)
      expect(posts.length).toBeGreaterThan(0)
      expect(posts[0].body.strictSkus).toBe(true)
      expect(requests(mock(), "PUT", CONFIRMS)).toHaveLength(0)
    })

    it("holds a not-fulfillable draft", async () => {
      mock().state.createFulfillableStatus = "not-fulfillable"
      mock().state.webhookUrl = `${HARNESS.backendUrl}/hooks/print-trail`
      const { orderId } = await placeOrder(api, seed, [{ variantId: seed.variants.pt, quantity: 1 }])
      const row = await waitFor(async () => {
        const r = await rowFor(container(), orderId)
        return r?.block_reason === "not-fulfillable" ? r : undefined
      }, { what: "not-fulfillable" })
      expect(requests(mock(), "PUT", CONFIRMS)).toHaveLength(0)

      mock().setStatus(row.pt_uuid, "draft", "fulfillable")
      const reply = await mock().sendWebhook("order-fulfillable-status-updated", row.pt_uuid)
      expect(reply.status).toBe(202)
      await waitFor(async () => (await rowFor(container(), orderId))?.fulfillable_status === "fulfillable", {
        what: "fulfillable_status fulfillable",
      })
    })

    it("records a stock shortfall at confirm and retries safely", async () => {
      mock().state.stock[SKUS.ptZero] = 0
      const { orderId } = await placeOrder(api, seed, [{ variantId: seed.variants.ptZero, quantity: 1 }])
      const row = await waitFor(async () => {
        const r = await rowFor(container(), orderId)
        return r?.attention === "stock-shortfall" ? r : undefined
      }, { what: "stock-shortfall" })
      expect(row.pending_action).toBe("confirm")
      expect(row.shortfall).toEqual([expect.objectContaining({ sku: SKUS.ptZero, requested: 1, available: 0 })])

      mock().state.stock[SKUS.ptZero] = 5
      await updateRow(container(), { id: row.id, next_attempt_at: past() })
      await sweep()
      const after = await confirmedRow(orderId)
      expect(after.attention).toBeNull()
      // A draft is re-posted with its current lines before it confirms,
      // as an upsert of the same uuid: still one Print Trail order.
      const posts = requests(mock(), "POST", POSTS)
      expect(posts.slice(1).every((p) => p.body.uuid === row.pt_uuid)).toBe(true)
      expect(ptOrders(mock(), row.pt_order_number)).toHaveLength(1)
      expect(after.pt_uuid).toBe(row.pt_uuid)
    })

    it("a retry after a timeout upserts the same draft", async () => {
      const attempts = 1 + DEFAULT_RETRY_DELAYS_MS.length
      mock().fail(/\/orders$/, 503, undefined, attempts)
      const { orderId, displayId } = await placeOrder(api, seed, [{ variantId: seed.variants.pt, quantity: 1 }])
      const row = await waitFor(async () => {
        const r = await rowFor(container(), orderId)
        return r?.pending_action === "send" && r.last_error ? r : undefined
      }, {
        what: "a pending send retry",
        timeoutMs: DEFAULT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) + 5_000,
      })
      expect(row.pt_uuid).toBeNull()

      await updateRow(container(), { id: row.id, next_attempt_at: past() })
      await sweep()
      await confirmedRow(orderId)
      expect(ptOrders(mock(), `${HARNESS.prefix}${displayId}`)).toHaveLength(1)
      expect(requests(mock(), "PUT", CONFIRMS)).toHaveLength(1)
    })

    // A lost row: the order is confirmed at Print Trail, and the sweep posts
    // it again. legacy: an older Print Trail API, whose 409 carries no order.
    const adoptsAfter409 = async (legacy: boolean) => {
      mock().state.legacy = legacy
      const { orderId, displayId } = await placeOrder(api, seed, [{ variantId: seed.variants.pt, quantity: 1 }])
      const row = await confirmedRow(orderId)
      // As if the uuid had never been stored.
      await dismissLink(container(), row.id, orderId)
      await printTrail(container()).deletePrintTrailOrders(row.id)
      await backdateOrder(dbConnection, orderId, 10)

      await sweep()
      const adopted = await confirmedRow(orderId, "the adopted row")
      expect(adopted.id).not.toBe(row.id)
      expect(adopted.pt_uuid).toBe(row.pt_uuid)
      const posts = requests(mock(), "POST", POSTS)
      expect(posts).toHaveLength(2)
      const lookups = requests(mock(), "GET", /\/orders$/).filter((r) => r.path.includes("order-number="))
      expect(lookups).toHaveLength(legacy ? 1 : 0)
      const remote = ptOrders(mock(), `${HARNESS.prefix}${displayId}`)
      expect(remote).toHaveLength(1)
      // The adopted confirmation time is Print Trail's: confirmedAt, or the
      // countdown from an older Print Trail API.
      expect(new Date(adopted.confirmed_at)).toEqual(new Date(legacy ? remote[0].fulfillableFrom : remote[0].confirmedAt))
      expect(requests(mock(), "PUT", CONFIRMS)).toHaveLength(1)
    }

    // The typed 409 (API 1.1.0) carries the order: no lookup by number.
    it("adopts after a 409 instead of re-posting", () => adoptsAfter409(false))

    it("adopts after an older Print Trail API's 409 by looking the order up", () => adoptsAfter409(true))

    // API 1.1.1: the lost row's order was confirmed and has since shipped,
    // so the replay answers not-updatable. Adopted, then synced by the next
    // sweep: one shipped Medusa fulfilment and a completed order.
    it("adopts a confirmed order that has since finished, and syncs it", async () => {
      const { orderId } = await placeOrder(api, seed, [{ variantId: seed.variants.pt, quantity: 1 }])
      const row = await confirmedRow(orderId)
      await dismissLink(container(), row.id, orderId)
      await printTrail(container()).deletePrintTrailOrders(row.id)
      await backdateOrder(dbConnection, orderId, 10)
      mock().dispatch(row.pt_uuid)

      await sweep()
      const adopted = await confirmedRow(orderId, "the adopted row")
      expect(adopted).toMatchObject({ pt_uuid: row.pt_uuid, status: "complete", pending_action: "refetch" })
      expect(adopted.block_reason).toBeNull()
      expect(requests(mock(), "POST", POSTS)).toHaveLength(2)

      await sweep()
      const query = container().resolve(ContainerRegistrationKeys.QUERY)
      const medusaOrder = async () =>
        (await query.graph({ entity: "order", fields: ["id", "status", "fulfillments.id", "fulfillments.shipped_at"], filters: { id: orderId } }))
          .data[0] as any
      const done = await waitFor(async () => {
        const o = await medusaOrder()
        return o.status === "completed" ? o : undefined
      }, { what: "the adopted order completed" })
      expect(done.fulfillments).toHaveLength(1)
      expect(done.fulfillments[0].shipped_at).toBeTruthy()
      expect(await rowFor(container(), orderId)).toMatchObject({ pending_action: null, attention: null })
      expect(requests(mock(), "PUT", CONFIRMS)).toHaveLength(1)
      expect(requests(mock(), "POST", POSTS)).toHaveLength(2)
    })

    it("blocks an order with no country before it reaches Print Trail", async () => {
      const { orderId } = await createOrderDirect(container(), seed, [{ variantId: seed.variants.pt, quantity: 1 }], {
        address: { country_code: undefined as never },
      })
      await backdateOrder(dbConnection, orderId, 10)
      await sweep()
      const row = await rowFor(container(), orderId)
      expect(row?.block_reason).toBe("address-incomplete")
      expect(requests(mock(), "POST", POSTS)).toHaveLength(0)
    })

    it("never sends a zero-quantity line", async () => {
      const { orderId } = await createOrderDirect(container(), seed, [
        { variantId: seed.variants.pt, quantity: 1 },
        { variantId: seed.variants.pt2, quantity: 1 },
      ])
      const pt2 = (await orderItems(container(), orderId)).find((i) => i.variant_id === seed.variants.pt2)
      await removeItem(api, admin, orderId, pt2.id)
      await utils.waitWorkflowExecutions()
      await backdateOrder(dbConnection, orderId, 10)
      await sweep()

      await confirmedRow(orderId)
      const posts = requests(mock(), "POST", POSTS)
      expect(posts.length).toBeGreaterThan(0)
      for (const post of posts) {
        expect(post.body.orderLines.map((l: any) => l.product.sku)).toEqual([SKUS.pt])
        for (const line of post.body.orderLines) {
          expect(Number.isInteger(line.quantity) && line.quantity >= 1).toBe(true)
        }
      }
    })

    it("recovers a lost order.placed through the sweep", async () => {
      const { orderId } = await createOrderDirect(container(), seed, [{ variantId: seed.variants.pt, quantity: 1 }])
      await utils.waitWorkflowExecutions()
      expect(mock().state.requests).toHaveLength(0)
      await backdateOrder(dbConnection, orderId, 10)
      await sweep()
      await confirmedRow(orderId)
      expect(requests(mock(), "POST", POSTS)).toHaveLength(1)
    })

    it("does not re-post after a crash between confirm and confirmed_at", async () => {
      const { orderId } = await placeOrder(api, seed, [{ variantId: seed.variants.pt, quantity: 1 }])
      const row = await confirmedRow(orderId)
      const before = { posts: requests(mock(), "POST", POSTS).length, confirms: requests(mock(), "PUT", CONFIRMS).length }
      await updateRow(container(), { id: row.id, confirmed_at: null, pending_action: "confirm", next_attempt_at: past() })

      await sweep()
      await confirmedRow(orderId, "confirmed_at recorded again")
      expect(requests(mock(), "POST", POSTS)).toHaveLength(before.posts)
      expect(requests(mock(), "PUT", CONFIRMS)).toHaveLength(before.confirms)
    })

    it("sweep skips cancelled and out-of-window orders", async () => {
      const cancelled = await createOrderDirect(container(), seed, [{ variantId: seed.variants.pt, quantity: 1 }])
      const old = await createOrderDirect(container(), seed, [{ variantId: seed.variants.pt, quantity: 1 }])
      const missed = await createOrderDirect(container(), seed, [{ variantId: seed.variants.pt, quantity: 1 }])
      await api.post(`/admin/orders/${cancelled.orderId}/cancel`, {}, admin)
      await utils.waitWorkflowExecutions()
      await backdateOrder(dbConnection, cancelled.orderId, 10)
      await backdateOrder(dbConnection, old.orderId, (LOOKBACK_DAYS + 1) * 24 * 60)
      await backdateOrder(dbConnection, missed.orderId, 10)

      // The send itself also refuses a cancelled order, so watch which orders
      // the sweep starts a send for: its own filters must leave these out.
      const started: string[] = []
      const sendModule = require(path.resolve(__dirname, "../../.medusa/server/src/workflows/send-order-to-print-trail.js"))
      const original = sendModule.sendOrderToPrintTrailWorkflow
      const spy = jest.spyOn(sendModule, "sendOrderToPrintTrailWorkflow").mockImplementation((c: unknown) => {
        const workflow = original(c)
        const run = workflow.run.bind(workflow)
        workflow.run = (args: { input: { order_id: string } }) => {
          started.push(args.input.order_id)
          return run(args)
        }
        return workflow
      })
      try {
        await sweep()
      } finally {
        spy.mockRestore()
      }
      // The control order shows the spy sees the sweep's sends.
      expect(started).toContain(missed.orderId)
      expect(started).not.toContain(cancelled.orderId)
      expect(started).not.toContain(old.orderId)
      expect(requests(mock(), "POST", POSTS).map((r) => r.body.orderNumber)).toEqual([`${HARNESS.prefix}${missed.displayId}`])
      expect(await rowFor(container(), old.orderId)).toBeUndefined()
    })
  },
})
