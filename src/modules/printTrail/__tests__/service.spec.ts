import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import { PRINT_TRAIL_MODULE } from ".."
import PrintTrailOrder from "../models/print-trail-order"
import PrintTrailOrderEvent from "../models/print-trail-order-event"
import PrintTrailState from "../models/print-trail-state"
import PrintTrailModuleService from "../service"

jest.setTimeout(60 * 1000)

const moduleModels = [PrintTrailOrder, PrintTrailOrderEvent, PrintTrailState]

moduleIntegrationTestRunner<PrintTrailModuleService>({
  moduleName: PRINT_TRAIL_MODULE,
  moduleModels,
  resolve: "./src/modules/printTrail",
  moduleOptions: { baseUrl: "http://mock.invalid", channelId: "t-c", apiToken: "x" },
  testSuite: ({ service }) => {
    describe("PrintTrailModuleService", () => {
      it("stores order rows with their defaults", async () => {
        const row = await service.createPrintTrailOrders({
          order_id: "order_1",
          pt_order_number: "ORD-1",
        })
        expect(row.id).toMatch(/^ptord_/)
        expect(row.sequence).toBe(1)
        expect(row.attempts).toEqual({})
        expect(row.cancel_requested).toBe(false)
        expect(row.confirmed_at).toBeNull()
      })

      // Medusa's repository updates with mergeObjectProperties: a JSON
      // object column is merged, so a key can't be removed by an update.
      // Retry counts are reset by writing 0, never by deleting the key.
      it("keeps SKUs seen on pre-order, add-only and case-insensitively", async () => {
        await service.markPreOrderSeen(["PRE-1", " "])
        await service.markPreOrderSeen(["pre-1", "PRE-2"])
        expect(await service.preOrderSeen(["pre-1", "PRE-2", "978-A"])).toEqual(["pre-1", "PRE-2"])
        expect(await service.preOrderSeen([])).toEqual([])
      })

      it("replaces a state value whole, so removed keys stay removed", async () => {
        await service.setState("records", { a: { n: 1 }, b: { n: 2 } })
        await service.setState("records", { b: { n: 3 } })
        expect(await service.getState("records")).toEqual({ b: { n: 3 } })
        await service.setState("records", null)
        expect(await service.getState("records")).toBeNull()
        await service.setState("records", { c: 1 })
        expect(await service.getState("records")).toEqual({ c: 1 })
      })

      it("merges JSON object columns on update", async () => {
        const row = await service.createPrintTrailOrders({ order_id: "order_merge", pt_order_number: "ORD-M", attempts: { a: 1, b: 2 } as never })
        await service.updatePrintTrailOrders({ id: row.id, attempts: { b: 3 } as never })
        expect((await service.retrievePrintTrailOrder(row.id)).attempts).toEqual({ a: 1, b: 3 })
        await service.updatePrintTrailOrders({ id: row.id, attempts: { a: 0 } as never })
        expect((await service.retrievePrintTrailOrder(row.id)).attempts).toEqual({ a: 0, b: 3 })
      })

      it("allows one row per order and sequence", async () => {
        await service.createPrintTrailOrders({ order_id: "order_2", pt_order_number: "ORD-2" })
        await expect(
          service.createPrintTrailOrders({ order_id: "order_2", pt_order_number: "ORD-2" })
        ).rejects.toThrow()
        const second = await service.createPrintTrailOrders({
          order_id: "order_2",
          sequence: 2,
          pt_order_number: "ORD-2-2",
        })
        expect(second.sequence).toBe(2)
      })

      it("allows one row per order and source_ref, and any number without one", async () => {
        await service.createPrintTrailOrders({ order_id: "order_3", sequence: 2, pt_order_number: "ORD-3-2", source_ref: "claim:c1" })
        await expect(
          service.createPrintTrailOrders({ order_id: "order_3", sequence: 3, pt_order_number: "ORD-3-3", source_ref: "claim:c1" })
        ).rejects.toThrow()
        await service.createPrintTrailOrders({ order_id: "order_3", sequence: 4, pt_order_number: "ORD-3-4" })
        const fifth = await service.createPrintTrailOrders({ order_id: "order_3", sequence: 5, pt_order_number: "ORD-3-5" })
        expect(fifth.source_ref).toBeNull()
      })

      it("round-trips the cancel and amend columns", async () => {
        const row = await service.createPrintTrailOrders({
          order_id: "order_4",
          pt_order_number: "ORD-4",
          cancel_status: "awaiting",
          address_hash: "abc",
          held_lines: [{ lineItemId: "i1", quantity: 2 }] as never,
        })
        const [read] = await service.listPrintTrailOrders({ id: row.id })
        expect(read.cancel_status).toBe("awaiting")
        expect(read.address_hash).toBe("abc")
        expect(read.held_lines).toEqual([{ lineItemId: "i1", quantity: 2 }])
        expect(read.cancel_notified_at).toBeNull()
      })

      it("records timeline events", async () => {
        const e = await service.createPrintTrailOrderEvents({
          order_id: "order_1",
          kind: "sent",
          message: "Sent to Print Trail",
        })
        expect(e.id).toMatch(/^ptevt_/)
        expect(e.customer_visible).toBe(false)
      })

      it("round-trips state values", async () => {
        expect(await service.getState("cursor")).toBeNull()
        await service.setState("cursor", { at: "2026-10-18T00:00:00Z" })
        await service.setState("cursor", { at: "2026-10-18T06:00:00Z" })
        expect(await service.getState("cursor")).toEqual({ at: "2026-10-18T06:00:00Z" })
        expect(await service.listPrintTrailStates({ key: "cursor" })).toHaveLength(1)
      })

      it("upserts state when two writers race on a new key", async () => {
        await Promise.all([
          service.setState("race", { n: 1 }),
          service.setState("race", { n: 2 }),
          service.setState("race", { n: 3 }),
        ])
        expect(await service.listPrintTrailStates({ key: "race" })).toHaveLength(1)
        expect([1, 2, 3]).toContain((await service.getState<{ n: number }>("race"))!.n)
      })

      it("records the startup locking check in state", async () => {
        expect(await service.getLockingCheck()).toEqual({ provider: "in-memory", postgresConfigured: false, supported: true })
        await service.recordLockingCheck()
        expect(await service.getState("locking_check")).toEqual({ provider: "in-memory", postgresConfigured: false, supported: true })
      })

      it("queues keys once and takes them oldest first", async () => {
        await service.queueStateKeys("sku_check:", ["v1", "v2"])
        await Promise.all([service.queueStateKeys("sku_check:", ["v2", "v3"]), service.queueStateKeys("sku_check:", ["v3"])])
        expect(await service.takeStateKeys("sku_check:", 2)).toEqual(["v1", "v2"])
        expect(await service.takeStateKeys("sku_check:", 10)).toEqual(["v3"])
        expect(await service.takeStateKeys("sku_check:", 10)).toEqual([])
        // Other keys are untouched.
        await service.setState("sku_check_unmatched", { skus: [] })
        expect(await service.takeStateKeys("sku_check:", 10)).toEqual([])
        expect(await service.getState("sku_check_unmatched")).toEqual({ skus: [] })
      })

      it("builds the client once from the plugin options", async () => {
        expect(await service.isConnected()).toBe(true)
        expect(await service.getClient()).toBe(await service.getClient())
        expect((await service.getOptions()).defaultShippingMethod).toBe("standard")
      })
    })
  },
})

moduleIntegrationTestRunner<PrintTrailModuleService>({
  moduleName: PRINT_TRAIL_MODULE,
  moduleModels,
  resolve: "./src/modules/printTrail",
  testSuite: ({ service }) => {
    describe("PrintTrailModuleService without credentials", () => {
      it("is not connected and refuses to build a client", async () => {
        expect(await service.isConnected()).toBe(false)
        await expect(service.getClient()).rejects.toThrow("Print Trail API is not connected")
      })
    })
  },
})
