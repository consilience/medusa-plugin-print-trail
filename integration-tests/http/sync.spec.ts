import { createHmac, randomUUID } from "node:crypto"
import path from "node:path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { HARNESS, SKUS, useMock } from "./harness"
import { runJob, stockJob, webhookStockRun } from "./helpers/jobs"
import { CONFIRMS, eventsFor, printTrail, requests, rowFor, rowsFor, updateRow } from "./helpers/rows"
import { seedStore, type Seed } from "./helpers/seed"
import { placeOrder } from "./helpers/store"
import { sleep, waitFor } from "./helpers/wait"

jest.setTimeout(120_000)

const mock = useMock({ locations: { [SKUS.pt]: "LOC-A", [SKUS.pt2]: "LOC-B" } })
const HOOK = `${HARNESS.backendUrl}/hooks/print-trail`
const sign = (bytes: string) => createHmac("sha256", HARNESS.webhookSecret).update(bytes).digest("hex")

medusaIntegrationTestRunner({
  cwd: path.join(__dirname, "app"),
  testSuite: ({ api, getContainer, utils }) => {
    let seed: Seed
    const container = () => getContainer()
    const job = (name: "print-trail-sweep" | "print-trail-reconcile" | "print-trail-stock-sync") =>
      runJob(container(), name, utils.waitWorkflowExecutions)
    const raw = (body: string, headers: Record<string, string>) =>
      api.post("/hooks/print-trail", body, {
        headers,
        transformRequest: [(d: unknown) => d],
        validateStatus: () => true,
      })

    const confirmedOrder = async (lines: { variantId: string; quantity: number }[]) => {
      const { orderId, displayId } = await placeOrder(api, seed, lines)
      const row = await waitFor(async () => {
        const r = await rowFor(container(), orderId)
        return r?.confirmed_at ? r : undefined
      }, { what: "a confirmed row" })
      return { orderId, displayId, row }
    }

    const medusaOrder = async (orderId: string) => {
      const query = container().resolve(ContainerRegistrationKeys.QUERY)
      const { data } = await query.graph({
        entity: "order",
        fields: ["id", "status", "fulfillments.id", "fulfillments.shipped_at", "fulfillments.labels.tracking_number"],
        filters: { id: orderId },
      })
      return data[0] as any
    }
    const shipmentEmails = () =>
      container().resolve(Modules.NOTIFICATION).listNotifications({ template: "print-trail-shipment" })

    const levelOf = async (variantId: string) => {
      const query = container().resolve(ContainerRegistrationKeys.QUERY)
      const { data } = await query.graph({
        entity: "variant",
        fields: ["id", "allow_backorder", "inventory_items.inventory.location_levels.stocked_quantity", "inventory_items.inventory.location_levels.location_id"],
        filters: { id: variantId },
      })
      const v = data[0] as any
      const level = v.inventory_items[0].inventory.location_levels.find((l: any) => l.location_id === seed.stockLocationId)
      return { stocked: level?.stocked_quantity as number, allowBackorder: v.allow_backorder as boolean }
    }

    beforeAll(async () => {
      seed = await seedStore(container())
    })

    beforeEach(() => {
      mock().state.webhookUrl = HOOK
    })

    it("two locations: one Print Trail order, two fulfilments, one shipment each", async () => {
      const { orderId, row } = await confirmedOrder([
        { variantId: seed.variants.pt, quantity: 1 },
        { variantId: seed.variants.pt2, quantity: 1 },
      ])
      const pt = mock().state.orders.get(row.pt_uuid)
      expect(pt.fulfilments).toHaveLength(2)
      expect(pt.fulfilments[0].supplierLocation.code).toBe("LOC-A")

      mock().dispatch(row.pt_uuid, 0)
      expect((await mock().sendWebhook("fulfilment-status-updated", row.pt_uuid)).status).toBe(202)
      const first = await waitFor(async () => {
        const o = await medusaOrder(orderId)
        return o.fulfillments?.length === 1 && o.fulfillments[0].shipped_at ? o : undefined
      }, { what: "the first shipped fulfilment" })
      const trackingA = pt.fulfilments[0].trackingDetails[0].trackingNumber
      expect(first.fulfillments[0].labels.map((l: any) => l.tracking_number)).toEqual([trackingA])
      await waitFor(async () => (await shipmentEmails()).length === 1, { what: "one shipment email" })

      mock().dispatch(row.pt_uuid, 1)
      await mock().sendWebhook("fulfilment-status-updated", row.pt_uuid)
      await waitFor(async () => {
        const o = await medusaOrder(orderId)
        return o.fulfillments.length === 2 && o.fulfillments.every((f: any) => f.shipped_at)
      }, { what: "two shipped fulfilments" })
      await waitFor(async () => (await shipmentEmails()).length === 2, { what: "two shipment emails" })
      await waitFor(async () => (await medusaOrder(orderId)).status === "completed", { what: "the order completed" })
    })

    it("a partial Print Trail order ships its parcel and is left for an admin to complete", async () => {
      const { orderId, row } = await confirmedOrder([
        { variantId: seed.variants.pt, quantity: 1 },
        { variantId: seed.variants.pt2, quantity: 1 },
      ])
      // Print Trail: all finished, one dispatched, one lost → partial (final).
      mock().dispatch(row.pt_uuid, 0)
      mock().cancelFulfilment(row.pt_uuid, 1)
      expect(mock().state.orders.get(row.pt_uuid).status).toBe("partial")
      await mock().sendWebhook("fulfilment-status-updated", row.pt_uuid)

      await waitFor(async () => {
        const o = await medusaOrder(orderId)
        return o.fulfillments?.length === 1 && o.fulfillments[0].shipped_at
      }, { what: "the dispatched parcel shipped in Medusa" })
      const flagged = await waitFor(async () => {
        const r = await rowFor(container(), orderId)
        return r?.attention === "complete-manually" ? r : undefined
      }, { what: "complete-manually" })
      expect(flagged.status).toBe("partial")
      await utils.waitWorkflowExecutions()
      expect((await medusaOrder(orderId)).status).not.toBe("completed")
    })

    it("replaying a webhook changes nothing", async () => {
      const { orderId, row } = await confirmedOrder([{ variantId: seed.variants.pt, quantity: 1 }])
      mock().dispatch(row.pt_uuid, 0)
      await mock().sendWebhook("fulfilment-status-updated", row.pt_uuid)
      await waitFor(async () => (await shipmentEmails()).length === 1, { what: "one shipment email" })
      await waitFor(async () => (await medusaOrder(orderId)).status === "completed", { what: "the order completed" })
      // The dispatch sync's follow-ups (stock refresh, subscribers) can still
      // be writing: wait until the timeline has been still for a second.
      let count = -1
      await waitFor(async () => {
        const now = (await eventsFor(container(), orderId)).length
        const still = now === count
        count = now
        return still
      }, { what: "a quiet timeline", intervalMs: 1000 })
      await utils.waitWorkflowExecutions()
      const before = { events: (await eventsFor(container(), orderId)).length, fulfilments: (await medusaOrder(orderId)).fulfillments.length }

      await mock().sendWebhook("fulfilment-status-updated", row.pt_uuid)
      await mock().sendWebhook("fulfilment-status-updated", row.pt_uuid)
      await sleep(1500)
      await utils.waitWorkflowExecutions()
      expect((await eventsFor(container(), orderId)).length).toBe(before.events)
      expect((await medusaOrder(orderId)).fulfillments).toHaveLength(before.fulfilments)
      expect(await shipmentEmails()).toHaveLength(1)
    })

    it("rejects a bad signature", async () => {
      const { orderId, row } = await confirmedOrder([{ variantId: seed.variants.pt, quantity: 1 }])
      const before = (await eventsFor(container(), orderId)).length
      mock().setStatus(row.pt_uuid, "processing")
      const reply = await mock().sendWebhook("order-status-updated", row.pt_uuid, { secret: "wrong-secret" })
      expect(reply.status).toBe(401)
      await sleep(500)
      expect((await eventsFor(container(), orderId)).length).toBe(before)
      expect((await rowFor(container(), orderId)).status).not.toBe("processing")
    })

    it("rejects a missing signature", async () => {
      const body = JSON.stringify({ notificationType: "order-status-updated", orderUuid: randomUUID() })
      const reply = await raw(body, { "Content-Type": "application/json" })
      expect(reply.status).toBe(401)
    })

    it("checks a text/plain body's signature as it does JSON's", async () => {
      // 2.17.2's preserveRawBody keeps a text/plain body's bytes too (seen in a
      // real store), so the content type changes nothing: the HMAC decides.
      const body = JSON.stringify({ notificationType: "order-status-updated", orderUuid: randomUUID() })
      const signed = await raw(body, { "Content-Type": "text/plain", Signature: sign(body) })
      expect(signed.status).toBe(200)
      expect(signed.data).toEqual({ status: "ignored" })
      const forged = await raw(body, { "Content-Type": "text/plain", Signature: sign(`${body} `) })
      expect(forged.status).toBe(401)
      const unsigned = await raw(body, { "Content-Type": "text/plain" })
      expect(unsigned.status).toBe(401)
    })

    it("verifies the raw bytes behind Medusa's body parser", async () => {
      const body = `{ "orderUuid" : "${randomUUID()}",   "notificationType":"order-status-updated" }`
      const reply = await raw(body, { "Content-Type": "application/json", Signature: sign(body) })
      // Accepted: an unknown uuid is ignored with 200, a known one queued with 202.
      expect([200, 202]).toContain(reply.status)
      const tampered = await raw(JSON.stringify(JSON.parse(body)), { "Content-Type": "application/json", Signature: sign(body) })
      expect(tampered.status).toBe(401)
    })

    it("answers 200 for an unknown order uuid", async () => {
      const reply = await mock().sendWebhook("order-status-updated", randomUUID())
      expect(reply).toEqual({ status: 200, body: { status: "ignored" } })
    })

    it("a Print Trail cancel sets attention and is never re-confirmed", async () => {
      const { orderId, row } = await confirmedOrder([{ variantId: seed.variants.pt, quantity: 1 }])
      mock().setStatus(row.pt_uuid, "cancelled")
      await mock().sendWebhook("order-status-updated", row.pt_uuid)
      await waitFor(async () => (await rowFor(container(), orderId))?.attention === "pt-cancelled", { what: "pt-cancelled" })
      const confirms = requests(mock(), "PUT", CONFIRMS).length
      // Due for a confirm retry, as a run that died before recording its
      // confirm leaves it: the sweep must still not confirm (or re-post) an
      // order Print Trail cancelled.
      await updateRow(container(), {
        id: row.id,
        confirmed_at: null,
        pending_action: "confirm",
        next_attempt_at: new Date(Date.now() - 60_000),
      })
      const posts = requests(mock(), "POST", /\/orders$/).length
      await job("print-trail-sweep")
      expect(requests(mock(), "PUT", CONFIRMS)).toHaveLength(confirms)
      expect(requests(mock(), "POST", /\/orders$/)).toHaveLength(posts)
      const after = await rowFor(container(), orderId)
      expect(after.attention).toBe("pt-cancelled")
      // The sweep did take the row (its retry is settled), and confirmed nothing.
      expect(after.pending_action).toBeNull()
    })

    it("reconcile flags a draft after confirm", async () => {
      const { orderId, row } = await confirmedOrder([{ variantId: seed.variants.pt, quantity: 1 }])
      mock().fullEdit(row.pt_uuid)
      await job("print-trail-reconcile")
      await waitFor(async () => (await rowFor(container(), orderId))?.attention === "pt-draft-after-confirm", {
        what: "pt-draft-after-confirm",
      })
    })

    it("a -COPY order is noted, never adopted", async () => {
      const { orderId, row } = await confirmedOrder([{ variantId: seed.variants.pt, quantity: 1 }])
      const copyUuid = mock().copy(row.pt_uuid)
      await mock().sendWebhook("order-created", copyUuid)
      await waitFor(async () => (await eventsFor(container(), orderId)).some((e) => e.kind === "pt-copy"), {
        what: "the copy's timeline entry",
      })
      await mock().sendWebhook("order-created", copyUuid)
      await sleep(500)
      await utils.waitWorkflowExecutions()
      expect((await eventsFor(container(), orderId)).filter((e) => e.kind === "pt-copy")).toHaveLength(1)
      expect(await rowsFor(container(), orderId)).toHaveLength(1)
      expect(await printTrail(container()).listPrintTrailOrders({ pt_uuid: copyUuid })).toHaveLength(0)
    })

    it("stock-level-updated runs a full stock sync", async () => {
      mock().state.stock[SKUS.pt] = 7
      mock().state.stock[SKUS.pt2] = 9
      const before: string | undefined = (await printTrail(container()).getState("stock_last_run"))?.completedAt
      expect((await mock().sendWebhook("stock-level-updated")).status).toBe(202)
      // A run still holding the stock lock defers this one to the sweep.
      await webhookStockRun(container(), before, utils.waitWorkflowExecutions)
      await waitFor(async () => (await levelOf(seed.variants.pt)).stocked === 7, { what: "pt's level at 7" })
      await waitFor(async () => (await levelOf(seed.variants.pt2)).stocked === 9, { what: "pt2's level at 9" })
    })

    it("the stock job syncs print-on-demand stock", async () => {
      await stockJob(container(), utils.waitWorkflowExecutions)
      // 10003: print-on-demand with 3 in the warehouse: the 3 is the
      // level and backorders are allowed.
      expect(await levelOf(seed.variants.pod)).toEqual({ stocked: 3, allowBackorder: true })
      expect((await levelOf(seed.variants.pt)).stocked).toBe(mock().state.stock[SKUS.pt])
    })
  },
})
