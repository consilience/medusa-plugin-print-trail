import path from "node:path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules } from "@medusajs/framework/utils"
import { HARNESS, useMock } from "./harness"
import { adminHeaders, editItemQuantity, type Headers } from "./helpers/admin"
import { runJob } from "./helpers/jobs"
import { CANCELS, eventsFor, LINES, requests, rowFor, updateRow } from "./helpers/rows"
import { seedStore, type Seed } from "./helpers/seed"
import { orderItems, placeOrder } from "./helpers/store"
import { sleep, waitFor } from "./helpers/wait"

// Read by the fixture's config when the runner loads it, after this line.
process.env.PT_HARNESS_OPTIONS = JSON.stringify({ notifications: { adminEmail: "ops@harness.test" } })

jest.setTimeout(120_000)

const mock = useMock()

medusaIntegrationTestRunner({
  cwd: path.join(__dirname, "app"),
  testSuite: ({ api, getContainer, utils }) => {
    let seed: Seed
    let admin: Headers
    const container = () => getContainer()
    const sweep = () => runJob(container(), "print-trail-sweep", utils.waitWorkflowExecutions)
    const rowWhere = (orderId: string, ok: (r: any) => boolean, what: string) =>
      waitFor(async () => {
        const r = await rowFor(container(), orderId)
        return r && ok(r) ? r : undefined
      }, { what })
    const confirmedOrder = async () => {
      const { orderId } = await placeOrder(api, seed, [{ variantId: seed.variants.pt, quantity: 1 }])
      const row = await rowWhere(orderId, (r) => !!r.confirmed_at, "a confirmed row")
      return { orderId, row }
    }
    const tooLateEmails = () =>
      container().resolve(Modules.NOTIFICATION).listNotifications({ template: "print-trail-cancel-too-late" })

    beforeAll(async () => {
      seed = await seedStore(container())
      admin = await adminHeaders(container())
    })

    beforeEach(() => {
      mock().state.webhookUrl = `${HARNESS.backendUrl}/hooks/print-trail`
    })

    it("cancel after dispatch: 428, too-late note and one admin email, no retry loop", async () => {
      const { orderId, row } = await confirmedOrder()
      mock().dispatch(row.pt_uuid, 0)
      await api.post(`/admin/orders/${orderId}/cancel`, {}, admin)

      await rowWhere(orderId, (r) => r.cancel_status === "too-late" && r.attention === "cancel-too-late", "too-late")
      const emails = await waitFor(async () => {
        const list = await tooLateEmails()
        return list.length ? list : undefined
      }, { what: "the too-late email" })
      expect(emails).toHaveLength(1)
      expect(emails[0].to).toBe("ops@harness.test")
      expect(requests(mock(), "PUT", CANCELS)).toHaveLength(1)

      await sweep()
      await sweep()
      expect(requests(mock(), "PUT", CANCELS)).toHaveLength(1)
      expect(await tooLateEmails()).toHaveLength(1)

      // Run the cancel again, as a retry would, so the too-late path is
      // reached a second time: the note and email go out once per row, kept
      // by cancel_notified_at and, without it, by the existing entry.
      const tooLate = await rowFor(container(), orderId)
      for (const cancel_notified_at of [tooLate.cancel_notified_at, null]) {
        await updateRow(container(), {
          id: tooLate.id,
          cancel_status: "requested",
          pending_action: "cancel",
          next_attempt_at: new Date(Date.now() - 60_000),
          cancel_notified_at,
        })
        await sweep()
        await rowWhere(orderId, (r) => r.cancel_status === "too-late", "too-late again")
      }
      expect(requests(mock(), "PUT", CANCELS)).toHaveLength(3)
      expect(await tooLateEmails()).toHaveLength(1)
      expect((await eventsFor(container(), orderId)).filter((e) => e.kind === "cancel-too-late")).toHaveLength(1)
    })

    it("cancel while processing: 202, awaiting, settled by webhook", async () => {
      const { orderId, row } = await confirmedOrder()
      mock().setStatus(row.pt_uuid, "processing")
      await api.post(`/admin/orders/${orderId}/cancel`, {}, admin)
      const awaiting = await rowWhere(orderId, (r) => r.cancel_status === "awaiting", "cancel awaiting")
      expect(awaiting.status).not.toBe("cancelled")

      mock().settleCancel(row.pt_uuid, "cancelled")
      await mock().sendWebhook("order-status-updated", row.pt_uuid)
      await rowWhere(orderId, (r) => r.cancel_status === "cancelled" && r.status === "cancelled", "cancel settled")
    })

    it("an edit after production started notes the refusal", async () => {
      const { orderId } = await confirmedOrder()
      const merchantMessage = "Change it in Print Trail"
      mock().fail(LINES, 409, {
        type: "about:blank",
        title: "Conflict",
        status: 409,
        detail: "Production has started.",
        reason: "production-started",
        merchantMessage,
      }, 1)
      const [item] = await orderItems(container(), orderId)
      await editItemQuantity(api, admin, orderId, item.id, 2)

      await rowWhere(orderId, (r) => r.attention === "amend-refused", "amend-refused")
      // The attention is set just before the timeline entry is written.
      const entry = await waitFor(
        async () => (await eventsFor(container(), orderId)).find((e) => e.kind === "amend-refused"),
        { what: "the amend-refused timeline entry" }
      )
      expect(entry.message).toContain(merchantMessage)
    })

    it("an edit before production amends the lines", async () => {
      const { orderId } = await confirmedOrder()
      const [item] = await orderItems(container(), orderId)
      await editItemQuantity(api, admin, orderId, item.id, 2)

      await waitFor(async () => (await eventsFor(container(), orderId)).some((e) => e.kind === "amended"), {
        what: "an amended entry",
      })
      const puts = requests(mock(), "PUT", LINES)
      expect(puts).toHaveLength(1)
      expect(puts[0].body.orderLines).toEqual([expect.objectContaining({ lineNumber: item.id, quantity: 2 })])
      await sleep(200)
      expect((await rowFor(container(), orderId)).attention).toBeNull()
    })
  },
})
