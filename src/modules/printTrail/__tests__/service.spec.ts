import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import { PRINT_TRAIL_MODULE } from ".."
import PrintTrailOrder from "../models/print-trail-order"
import PrintTrailOrderEvent from "../models/print-trail-order-event"
import PrintTrailState from "../models/print-trail-state"
import PrintTrailVariant from "../models/print-trail-variant"
import PrintTrailModuleService from "../service"

jest.setTimeout(60 * 1000)

const moduleModels = [PrintTrailOrder, PrintTrailOrderEvent, PrintTrailState, PrintTrailVariant]

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

      describe("per-variant SKU checks", () => {
        const AT = "2026-10-19T12:00:00.000Z"
        const check = (sku: string | null, status: string, over: Record<string, unknown> = {}) =>
          ({ sku, status, checked_at: AT, ...over }) as never

        it("creates a variant's row, then updates every check column", async () => {
          await service.writeVariantCheck({ variantId: "var_w1", productId: "prod_w", check: check("SKU-1", "matched", { matched_sku: "sku-canon" }), source: "sku-check" })
          let rows = await service.variantRows(["var_w1", "var_none"])
          expect(rows.size).toBe(1)
          expect(rows.get("var_w1")).toMatchObject({
            id: expect.stringMatching(/^ptvar_/),
            product_id: "prod_w",
            check_sku: "SKU-1",
            check_status: "matched",
            check_matched_sku: "sku-canon",
            check_note: null,
            check_source: "sku-check",
          })
          await service.writeVariantCheck({ variantId: "var_w1", productId: "prod_w", check: check("SKU-2", "not-found"), source: "sku-check" })
          rows = await service.variantRows(["var_w1"])
          expect(rows.get("var_w1")).toMatchObject({ check_sku: "SKU-2", check_status: "not-found", check_matched_sku: null })
          expect(await service.listPrintTrailVariants({ variant_id: "var_w1" })).toHaveLength(1)
        })

        it("leaves one row when two writers create a variant's row at once", async () => {
          await Promise.all([
            service.writeVariantCheck({ variantId: "var_race", productId: "prod_r", check: check("A", "matched"), source: "sku-check" }),
            service.writeVariantCheck({ variantId: "var_race", productId: "prod_r", check: check("A", "inactive"), source: "sku-check" }),
            service.writeVariantCheck({ variantId: "var_race", productId: "prod_r", check: check("A", "pre-order"), source: "sku-check" }),
          ])
          expect(await service.listPrintTrailVariants({ variant_id: "var_race" })).toHaveLength(1)
        })

        it("adopts legacy checks only where the variant has no row", async () => {
          await service.writeVariantCheck({ variantId: "var_a1", productId: "prod_a", check: check("NEW", "matched"), source: "sku-check" })
          const created = await service.adoptVariantChecks([
            { variantId: "var_a1", productId: "prod_a", check: check("OLD", "not-found") },
            { variantId: "var_a2", productId: "prod_a", check: check("OLD-2", "inactive") },
          ])
          expect(created).toBe(1)
          const rows = await service.variantRows(["var_a1", "var_a2"])
          expect(rows.get("var_a1")).toMatchObject({ check_sku: "NEW", check_source: "sku-check" })
          expect(rows.get("var_a2")).toMatchObject({ check_sku: "OLD-2", check_status: "inactive", check_source: "metadata" })
          expect(await service.adoptVariantChecks([{ variantId: "var_a2", productId: "prod_a", check: check("X", "matched") }])).toBe(0)
          expect(await service.adoptVariantChecks([])).toBe(0)
        })

        it("adopts a legacy check whose checked_at is missing or isn't a date, with no time", async () => {
          const created = await service.adoptVariantChecks([
            { variantId: "var_t1", productId: "prod_t", check: check("T-1", "matched", { checked_at: "" }) },
            { variantId: "var_t2", productId: "prod_t", check: check("T-2", "not-found", { checked_at: "not a date" }) },
          ])
          expect(created).toBe(2)
          const rows = await service.variantRows(["var_t1", "var_t2"])
          expect(rows.get("var_t1")).toMatchObject({ check_sku: "T-1", check_status: "matched", checked_at: null, check_source: "metadata" })
          expect(rows.get("var_t2")).toMatchObject({ check_sku: "T-2", check_status: "not-found", checked_at: null })
        })

        it("keeps a row written between the read and the batch create, and creates the rest", async () => {
          // The module's service is reached through a proxy, so the class is spied on.
          const read = PrintTrailModuleService.prototype.variantRows
          const spy = jest.spyOn(PrintTrailModuleService.prototype, "variantRows").mockImplementationOnce(async function (this: PrintTrailModuleService, ids) {
            const rows = await read.call(this, ids)
            // A SKU check lands after the read: the batch create conflicts.
            await service.writeVariantCheck({ variantId: "var_b1", productId: "prod_b", check: check("NEW", "matched"), source: "sku-check" })
            return rows
          })
          try {
            const created = await service.adoptVariantChecks([
              { variantId: "var_b1", productId: "prod_b", check: check("OLD-1", "not-found") },
              { variantId: "var_b2", productId: "prod_b", check: check("OLD-2", "inactive") },
            ])
            expect(created).toBe(1)
          } finally {
            spy.mockRestore()
          }
          const rows = await service.variantRows(["var_b1", "var_b2"])
          expect(rows.get("var_b1")).toMatchObject({ check_sku: "NEW", check_source: "sku-check" })
          expect(rows.get("var_b2")).toMatchObject({ check_sku: "OLD-2", check_status: "inactive", check_source: "metadata" })
          expect(await service.listPrintTrailVariants({ variant_id: ["var_b1", "var_b2"] })).toHaveLength(2)
        })

        it("skips a check the database refuses, and creates the rest", async () => {
          const created = await service.adoptVariantChecks([
            { variantId: "var_r1", productId: "prod_r", check: check("R-1", "matched") },
            // A row the database can't take (product_id is required).
            { variantId: "var_r2", productId: null as never, check: check("R-2", "matched") },
            { variantId: "var_r3", productId: "prod_r", check: check("R-3", "not-found") },
          ])
          expect(created).toBe(2)
          const rows = await service.variantRows(["var_r1", "var_r2", "var_r3"])
          expect([...rows.keys()].sort()).toEqual(["var_r1", "var_r3"])
        })

        it("fails when the database can't be read after a failed create, so nothing is taken as skipped", async () => {
          const proto = PrintTrailModuleService.prototype
          const list = proto.listPrintTrailVariants
          const lost = new Error("Connection terminated unexpectedly")
          const create = jest.spyOn(proto, "createPrintTrailVariants").mockRejectedValue(lost)
          // variantRows reads; the look for a row written meanwhile fails.
          const listing = jest
            .spyOn(proto, "listPrintTrailVariants")
            .mockImplementationOnce(function (this: PrintTrailModuleService, ...args: Parameters<typeof list>) {
              return list.apply(this, args)
            })
            .mockRejectedValueOnce(lost)
          try {
            await expect(
              service.adoptVariantChecks([{ variantId: "var_o1", productId: "prod_o", check: check("O-1", "matched") }])
            ).rejects.toThrow("Connection terminated unexpectedly")
          } finally {
            create.mockRestore()
            listing.mockRestore()
          }
          expect((await service.variantRows(["var_o1"])).size).toBe(0)
        })

        it("forgets variants by variant and by product", async () => {
          for (const [variantId, productId] of [["var_f1", "prod_f1"], ["var_f2", "prod_f1"], ["var_f3", "prod_f2"]]) {
            await service.writeVariantCheck({ variantId, productId, check: check("S", "matched"), source: "sku-check" })
          }
          expect(await service.forgetVariants({ variantIds: ["var_f3", "var_unknown"] })).toBe(1)
          expect(await service.forgetVariants({ productIds: ["prod_f1"] })).toBe(2)
          expect(await service.forgetVariants({})).toBe(0)
          expect((await service.variantRows(["var_f1", "var_f2", "var_f3"])).size).toBe(0)
          // Hard-deleted, not soft-deleted.
          expect(await service.listPrintTrailVariants({ variant_id: ["var_f1", "var_f2", "var_f3"] }, { withDeleted: true })).toHaveLength(0)
        })

        it("lists the SKUs a variant's or a product's rows were checked with", async () => {
          for (const [variantId, productId, sku] of [["var_k1", "prod_k1", "K-1"], ["var_k2", "prod_k1", "k-1"], ["var_k3", "prod_k1", "K-2"], ["var_k4", "prod_k2", "K-3"]]) {
            await service.writeVariantCheck({ variantId, productId, check: check(sku, "not-found"), source: "sku-check" })
          }
          await service.writeVariantCheck({ variantId: "var_k5", productId: "prod_k1", check: null, source: "stock-sync" })
          expect((await service.checkSkusOf({ productIds: ["prod_k1"] })).sort()).toEqual(["K-1", "K-2"])
          expect(await service.checkSkusOf({ variantIds: ["var_k4", "var_none"] })).toEqual(["K-3"])
          expect(await service.checkSkusOf({})).toEqual([])
        })

        it("finds the SKUs some row was checked with, whatever their case, and a SKU with _ or % only as itself", async () => {
          for (const [variantId, sku] of [["var_u1", "Book_1"], ["var_u2", "BOOKX1"], ["var_u3", "50-OFF"]]) {
            await service.writeVariantCheck({ variantId, productId: "prod_u", check: check(sku, "not-found"), source: "sku-check" })
          }
          expect(await service.checkedSkus(["BOOK_1", " book_1 ", "BOOKY1", "50%-off", "50-off", "absent", ""])).toEqual(["BOOK_1", " book_1 ", "50-off"])
          expect(await service.checkedSkus([])).toEqual([])
        })

        it("lists the distinct not-found SKUs", async () => {
          await service.writeVariantCheck({ variantId: "var_n1", productId: "prod_n", check: check("MISSING-1", "not-found"), source: "sku-check" })
          await service.writeVariantCheck({ variantId: "var_n2", productId: "prod_n", check: check("missing-1", "not-found"), source: "sku-check" })
          await service.writeVariantCheck({ variantId: "var_n3", productId: "prod_n", check: check("MISSING-2", "not-found"), source: "sku-check" })
          await service.writeVariantCheck({ variantId: "var_n4", productId: "prod_n", check: check("FOUND", "matched"), source: "sku-check" })
          expect((await service.notFoundSkus()).sort()).toEqual(["MISSING-1", "MISSING-2"])
        })

        it("pages the rows by id after the cursor", async () => {
          for (const id of ["var_p1", "var_p2", "var_p3"]) {
            await service.writeVariantCheck({ variantId: id, productId: "prod_p", check: check("S", "matched"), source: "sku-check" })
          }
          const all: string[] = []
          let after: string | null = null
          for (;;) {
            const page = await service.variantRowPage(after, 2)
            all.push(...page.map((r) => r.id))
            if (page.length < 2) break
            after = page[page.length - 1].id
          }
          expect(all).toEqual([...all].sort())
          expect(new Set(all).size).toBe(all.length)
          const mine = (await service.variantRows(["var_p1", "var_p2", "var_p3"])).values()
          for (const r of mine) expect(all).toContain(r.id)
        })

        it("sets statuses only where the check is still what was read", async () => {
          await service.writeVariantCheck({ variantId: "var_s1", productId: "prod_s", check: check("S-1", "matched", { matched_sku: "s-canon" }), source: "sku-check" })
          await service.writeVariantCheck({ variantId: "var_s2", productId: "prod_s", check: check("S-2", "matched"), source: "sku-check" })
          await service.writeVariantCheck({ variantId: "var_s3", productId: "prod_s", check: check("S-3", "not-found"), source: "sku-check" })
          const rows = await service.variantRows(["var_s1", "var_s2", "var_s3"])
          // A SKU check changed var_s2's SKU since it was read.
          await service.writeVariantCheck({ variantId: "var_s2", productId: "prod_s", check: check("S-2B", "matched"), source: "sku-check" })
          const at = new Date("2026-10-20T08:00:00.000Z")
          const written = await service.setCheckStatuses([
            { id: rows.get("var_s1")!.id, expect: { sku: "S-1", status: "matched" }, status: "pre-order", at },
            { id: rows.get("var_s2")!.id, expect: { sku: "S-2", status: "matched" }, status: "pre-order", at },
            { id: rows.get("var_s3")!.id, expect: { sku: "S-3", status: "matched" }, status: "inactive", at },
          ])
          expect(written).toBe(1)
          const after = await service.variantRows(["var_s1", "var_s2", "var_s3"])
          expect(after.get("var_s1")).toMatchObject({ check_sku: "S-1", check_status: "pre-order", check_matched_sku: "s-canon", check_source: "stock-sync" })
          expect(new Date(after.get("var_s1")!.checked_at as string).toISOString()).toBe(at.toISOString())
          expect(after.get("var_s2")).toMatchObject({ check_sku: "S-2B", check_status: "matched", check_source: "sku-check" })
          expect(after.get("var_s3")).toMatchObject({ check_status: "not-found" })
        })

        it("clears a check when the status is null", async () => {
          await service.writeVariantCheck({ variantId: "var_c1", productId: "prod_c", check: check("C-1", "not-found"), source: "sku-check" })
          const [r] = (await service.variantRows(["var_c1"])).values()
          expect(await service.setCheckStatuses([{ id: r.id, expect: { sku: "C-1", status: "not-found" }, status: null, at: new Date() }])).toBe(1)
          expect((await service.variantRows(["var_c1"])).get("var_c1")).toMatchObject({
            check_sku: null,
            check_status: null,
            check_matched_sku: null,
            check_note: null,
            checked_at: null,
            check_source: "stock-sync",
          })
          expect(await service.notFoundSkus()).not.toContain("C-1")
        })
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
