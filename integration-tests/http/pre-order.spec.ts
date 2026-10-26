// Pre-order products against the mock's API 1.3.0 behaviour
// (preOrderRelease on).
import path from "node:path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { updateProductVariantsWorkflow } from "@medusajs/medusa/core-flows"
import { HARNESS, PRE_ORDER_DATE, PRE_ORDER_MOCK, SKUS, useMock } from "./harness"
import { adminHeaders, type Headers } from "./helpers/admin"
import { runJob, stockJob as runStockJob, webhookStockRun as waitForWebhookStockRun } from "./helpers/jobs"
import { CONFIRMS, eventsFor, printTrail, requests, rowFor } from "./helpers/rows"
import { seedStore, settleSkuChecks, type Seed } from "./helpers/seed"
import { placeOrder } from "./helpers/store"
import { waitFor } from "./helpers/wait"

jest.setTimeout(120_000)

const mock = useMock(PRE_ORDER_MOCK)
const HOOK = `${HARNESS.backendUrl}/hooks/print-trail`

medusaIntegrationTestRunner({
  cwd: path.join(__dirname, "app"),
  testSuite: ({ api, getContainer, utils }) => {
    let seed: Seed
    let admin: Headers
    const container = () => getContainer()
    const job = (name: "print-trail-sweep" | "print-trail-reconcile" | "print-trail-stock-sync") =>
      runJob(container(), name, utils.waitWorkflowExecutions)

    const stockJob = () => runStockJob(container(), utils.waitWorkflowExecutions)
    const webhookStockRun = (before: string | undefined) => waitForWebhookStockRun(container(), before, utils.waitWorkflowExecutions)

    const confirmedOrder = async (lines: { variantId: string; quantity: number }[]) => {
      const { orderId } = await placeOrder(api, seed, lines)
      const row = await waitFor(async () => {
        const r = await rowFor(container(), orderId)
        return r?.confirmed_at ? r : undefined
      }, { what: "a confirmed row" })
      return { orderId, row }
    }

    const medusaOrder = async (orderId: string) => {
      const query = container().resolve(ContainerRegistrationKeys.QUERY)
      const { data } = await query.graph({
        entity: "order",
        fields: ["id", "status", "fulfillments.id", "fulfillments.shipped_at"],
        filters: { id: orderId },
      })
      return data[0] as any
    }

    const variantOf = async (variantId: string) => {
      const query = container().resolve(ContainerRegistrationKeys.QUERY)
      const { data } = await query.graph({
        entity: "variant",
        fields: [
          "id",
          "allow_backorder",
          "metadata",
          "inventory_items.inventory.location_levels.stocked_quantity",
          "inventory_items.inventory.location_levels.reserved_quantity",
          "inventory_items.inventory.location_levels.location_id",
        ],
        filters: { id: variantId },
      })
      const v = data[0] as any
      const level = v.inventory_items[0].inventory.location_levels.find((l: any) => l.location_id === seed.stockLocationId)
      return {
        stocked: Number(level?.stocked_quantity),
        reserved: Number(level?.reserved_quantity ?? 0),
        allowBackorder: v.allow_backorder as boolean,
        // The 0.2.0 backorder marker: since 1.0.0 the reason is kept in
        // stock_backordered (reasonOf), never here.
        marker: (v.metadata ?? {}).print_trail_backorder as unknown,
        // 0.1.1: the store-facing flag.
        preOrder: (v.metadata ?? {}).print_trail_pre_order as unknown,
        metadata: (v.metadata ?? {}) as Record<string, unknown>,
      }
    }

    // Why the plugin turned the variant's backorder on, from its own record;
    // undefined when it doesn't track it.
    const reasonOf = async (variantId: string) => {
      const record = await printTrail(container()).getState("stock_backordered")
      return record?.ids?.includes(variantId) ? (record.reasons?.[variantId] as string | undefined) : undefined
    }
    // The variant widget's stock block.
    const viewStock = async (variantId: string) => (await api.get(`/admin/print-trail/variants/${variantId}`, admin)).data.stock

    // The per-parcel emails of one order, oldest first.
    const shipmentEmails = async (orderId: string) => {
      const all = await container().resolve(Modules.NOTIFICATION).listNotifications({ template: "print-trail-shipment" })
      return (all as any[]).filter((n) => n.data?.order?.id === orderId).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    }

    const rowWhere = (orderId: string, what: string, test: (r: any) => boolean) =>
      waitFor(async () => {
        const r = await rowFor(container(), orderId)
        return r && test(r) ? r : undefined
      }, { what })

    // Dispatch one Print Trail fulfilment and tell the store.
    const ship = async (uuid: string, index: number) => {
      mock().dispatch(uuid, index)
      expect((await mock().sendWebhook("fulfilment-status-updated", uuid)).status).toBe(202)
    }

    beforeAll(async () => {
      seed = await seedStore(container())
      admin = await adminHeaders(container())
    })

    beforeEach(async () => {
      mock().state.preOrderRelease = true
      mock().state.webhookUrl = HOOK
      await stockJob()
    })

    it("a pre-order order is sent at checkout, waits, is released and completes", async () => {
      const { orderId, row } = await confirmedOrder([{ variantId: seed.variants.preOrder, quantity: 1 }])
      expect(requests(mock(), "PUT", CONFIRMS)).toHaveLength(1)
      expect(row.attention).toBeNull()
      const { data: view } = await api.get(`/admin/print-trail/orders/${orderId}`, admin)
      expect(view.rows[0].fulfilments).toEqual([
        expect.objectContaining({ status: "back-order", back_order: "pre-order", publication_date: PRE_ORDER_DATE }),
      ])
      expect(view.rows[0].cancel_warning).toBeNull()

      mock().state.stock[SKUS.preOrder] = 5
      await mock().setSkuStatus(SKUS.preOrder, "active")
      // Print Trail's shape: released back to draft on a re-queued order, with
      // confirmedAt kept and nothing at the warehouse yet.
      const released = await rowWhere(orderId, "the released fulfilment", (r) => r.fulfilments?.[0]?.status === "draft")
      expect(released).toMatchObject({ status: "queued", attention: null })
      expect(released.fulfilments[0]).toMatchObject({ backOrderReason: null, sentToWarehouseAt: null })
      expect(released.confirmed_at).toBeTruthy()
      // The countdown ends: the warehouse accepts it.
      mock().sendToWarehouse(row.pt_uuid, 0)
      expect((await mock().sendWebhook("fulfilment-status-updated", row.pt_uuid)).status).toBe(202)
      await rowWhere(orderId, "the fulfilment at the warehouse", (r) => r.fulfilments?.[0]?.status === "processing")
      await ship(row.pt_uuid, 0)
      const done = await waitFor(async () => {
        const o = await medusaOrder(orderId)
        return o.status === "completed" ? o : undefined
      }, { what: "the order completed" })
      expect(done.fulfillments).toHaveLength(1)
      expect(done.fulfillments[0].shipped_at).toBeTruthy()
      expect((await rowFor(container(), orderId)).attention).toBeNull()
    })

    it("a mixed order ships its in-stock parcel and waits for the rest", async () => {
      const { orderId, row } = await confirmedOrder([
        { variantId: seed.variants.pt, quantity: 1 },
        { variantId: seed.variants.preOrder, quantity: 1 },
      ])
      const pt = mock().state.orders.get(row.pt_uuid)
      const inStock = pt.fulfilments.findIndex((f: any) => f.status === "processing")
      const waiting = pt.fulfilments.findIndex((f: any) => f.status === "back-order")
      expect([inStock, waiting].sort()).toEqual([0, 1])

      await ship(row.pt_uuid, inStock)
      const first = await waitFor(async () => {
        const o = await medusaOrder(orderId)
        return o.fulfillments?.length === 1 && o.fulfillments[0].shipped_at ? o : undefined
      }, { what: "the in-stock parcel shipped" })
      await utils.waitWorkflowExecutions()
      expect((await medusaOrder(orderId)).status).not.toBe("completed")
      expect((await rowFor(container(), orderId)).attention).toBeNull()
      void first

      mock().state.stock[SKUS.preOrder] = 2
      await mock().setSkuStatus(SKUS.preOrder, "active")
      await rowWhere(orderId, "the released part", (r) => r.fulfilments?.[waiting]?.status === "processing")
      await ship(row.pt_uuid, waiting)
      await waitFor(async () => (await medusaOrder(orderId)).status === "completed", { what: "the order completed" })
      expect((await medusaOrder(orderId)).fulfillments).toHaveLength(2)

      // 0.1.1: the released parcel's email is the pre-order one; the
      // in-stock parcel's is ordinary.
      const emails = await waitFor(async () => {
        const e = await shipmentEmails(orderId)
        return e.length === 2 ? e : undefined
      }, { what: "two shipment emails" })
      const byParcel = (index: number) => {
        const fulfilment = mock().state.orders.get(row.pt_uuid).fulfilments[index]
        const tracking = fulfilment.trackingDetails[0].trackingNumber
        return emails.find((e: any) => e.data.tracking.some((t: any) => t.number === tracking))
      }
      expect(byParcel(inStock).data).toMatchObject({ pre_order: false })
      expect(byParcel(waiting).data).toMatchObject({ pre_order: true })
      expect((await rowFor(container(), orderId)).pre_order_fulfilments).toContain(pt.fulfilments[waiting].uuid)
    })

    it("the stock sync writes the store-facing pre-order flag", async () => {
      // beforeEach's run: the date, and the backorder with its reason in the
      // plugin's record rather than the variant's metadata.
      expect(await variantOf(seed.variants.preOrder)).toMatchObject({ preOrder: PRE_ORDER_DATE, marker: undefined, allowBackorder: true })
      expect(await reasonOf(seed.variants.preOrder)).toBe("pre-order")
      expect(await viewStock(seed.variants.preOrder)).toMatchObject({ pre_order_backorder: true, print_on_demand: false })
      expect((await variantOf(seed.variants.pt)).preOrder).toBeUndefined()
      // No publication date at Print Trail: true.
      delete mock().state.publicationDate[SKUS.preOrder]
      await stockJob()
      expect((await variantOf(seed.variants.preOrder)).preOrder).toBe(true)
      // A limited pre-order: flagged, with no plugin backorder.
      mock().state.publicationDate[SKUS.preOrder] = "2027-02-01"
      mock().state.preOrderLimit = { [SKUS.preOrder]: 5 }
      await stockJob()
      expect(await variantOf(seed.variants.preOrder)).toMatchObject({ preOrder: "2027-02-01", allowBackorder: false, stocked: 5 })
      // Live at Print Trail: the stock event's sync deletes it, keeping the
      // variant's other keys.
      await updateProductVariantsWorkflow(container()).run({
        input: { product_variants: [{ id: seed.variants.preOrder, metadata: { ...(await variantOf(seed.variants.preOrder)).metadata, store_key: "kept" } }] },
      })
      mock().state.stock[SKUS.preOrder] = 4
      await mock().setSkuStatus(SKUS.preOrder, "active")
      const live = await waitFor(async () => {
        const v = await variantOf(seed.variants.preOrder)
        return v.preOrder === undefined ? v : undefined
      }, { what: "the flag deleted" })
      expect(live.metadata).toMatchObject({ store_key: "kept" })
      // Back on pre-order with no date: true again. (The mock's changedAt
      // has whole seconds, so this second event can fall to the watermark;
      // the job stands in for it.)
      await mock().setSkuStatus(SKUS.preOrder, "pre-order", null)
      await stockJob()
      expect((await variantOf(seed.variants.preOrder)).preOrder).toBe(true)
    })

    // The README's storefront read. From 2.21 a store route silently drops a
    // field that isn't on its allowed list, and `variants.metadata` isn't
    // there; the default `*variants` returns it anyway.
    it("the store's product and cart routes return the pre-order flag", async () => {
      const h = { headers: { "x-publishable-api-key": seed.publishableKey } }
      const flagOf = async (fields?: string) => {
        const query = fields ? `&fields=${encodeURIComponent(fields)}` : ""
        const { data } = await api.get(`/store/products?handle=harness-preorder${query}`, h)
        return data.products[0].variants[0].metadata?.print_trail_pre_order
      }
      expect(await flagOf()).toBe(PRE_ORDER_DATE)
      expect(await flagOf("+variants.metadata")).toBe(PRE_ORDER_DATE)
      expect(await flagOf("id,title,*variants")).toBe(PRE_ORDER_DATE)
      const {
        data: { cart },
      } = await api.post("/store/carts", { region_id: seed.regionId, items: [{ variant_id: seed.variants.preOrder, quantity: 1 }] }, h)
      const { data } = await api.get(`/store/carts/${cart.id}?fields=${encodeURIComponent("*items.variant")}`, h)
      expect(data.cart.items[0].variant.metadata?.print_trail_pre_order).toBe(PRE_ORDER_DATE)
    })

    it("the stock sync keeps a 0-stock pre-order purchasable", async () => {
      expect(await variantOf(seed.variants.preOrder)).toMatchObject({ stocked: 0, allowBackorder: true })
      expect(await reasonOf(seed.variants.preOrder)).toBe("pre-order")
      // A store cart for it completes at 0 stock.
      const { orderId } = await placeOrder(api, seed, [{ variantId: seed.variants.preOrder, quantity: 1 }])
      await rowWhere(orderId, "the confirmed row", (r) => !!r.confirmed_at)

      // Live at Print Trail with 5 in stock: one stock-level-updated, and no
      // stock job run by the test.
      mock().state.stock[SKUS.preOrder] = 5
      await mock().setSkuStatus(SKUS.preOrder, "active")
      await waitFor(async () => {
        const v = await variantOf(seed.variants.preOrder)
        return !v.allowBackorder && v.stocked === 5 ? v : undefined
      }, { what: "backorders off at stock 5" })
      expect(await reasonOf(seed.variants.preOrder)).toBeUndefined()
      expect(await viewStock(seed.variants.preOrder)).toMatchObject({ pre_order_backorder: false })
    })

    it("a limited pre-order's level adds back Medusa's reservation", async () => {
      mock().state.preOrderLimit = { [SKUS.preOrder]: 5 }
      const { completedAt: before } = await stockJob()
      expect(await variantOf(seed.variants.preOrder)).toMatchObject({ stocked: 5, reserved: 0, allowBackorder: false })
      // Medusa reserves 1; Print Trail's remaining drops to 4, and its
      // stock-level-updated runs a full sync.
      await confirmedOrder([{ variantId: seed.variants.preOrder, quantity: 1 }])
      await webhookStockRun(before)
      expect(mock().state.requests.filter((r) => r.path.endsWith("/stock-levels")).length).toBeGreaterThan(0)
      const v = await variantOf(seed.variants.preOrder)
      expect(v).toMatchObject({ stocked: 5, reserved: 1 })
      // Medusa's availability is what remains of the limit.
      expect(v.stocked - v.reserved).toBe(4)
      await stockJob()
      expect(await variantOf(seed.variants.preOrder)).toMatchObject({ stocked: 5, reserved: 1 })
    })

    it("a store's own backorder flag is left alone", async () => {
      // The store turned backorders on itself (its own pre-order feature)
      // and the plugin doesn't track it.
      const service = printTrail(container())
      await service.setState("stock_backordered", { ids: [] })
      await updateProductVariantsWorkflow(container()).run({
        input: { product_variants: [{ id: seed.variants.preOrder, allow_backorder: true }] },
      })
      await stockJob()
      expect(await variantOf(seed.variants.preOrder)).toMatchObject({ allowBackorder: true })
      expect(await reasonOf(seed.variants.preOrder)).toBeUndefined()
      expect(await viewStock(seed.variants.preOrder)).toMatchObject({ pre_order_backorder: false, print_on_demand: false })
      // Never claimed, still flagged for the store.
      expect((await variantOf(seed.variants.preOrder)).preOrder).toBe(PRE_ORDER_DATE)

      mock().state.stock[SKUS.preOrder] = 3
      await mock().setSkuStatus(SKUS.preOrder, "active")
      await waitFor(async () => (await variantOf(seed.variants.preOrder)).stocked === 3, { what: "the webhook's sync" })
      await stockJob()
      expect(await variantOf(seed.variants.preOrder)).toMatchObject({ allowBackorder: true, stocked: 3 })
      expect((await variantOf(seed.variants.preOrder)).preOrder).toBeUndefined()
    })

    it("a confirm into an out-of-stock back-order is attention, not a retry loop", async () => {
      mock().state.backorderWarehouse = true
      // Medusa can still sell one; Print Trail has none.
      mock().state.stock[SKUS.ptZero] = 0
      const { orderId } = await placeOrder(api, seed, [{ variantId: seed.variants.ptZero, quantity: 1 }])
      const row = await rowWhere(orderId, "back-order attention", (r) => r.attention === "pt-fulfilment-back-order")
      expect(row).toMatchObject({ pending_action: null, shortfall: null })
      expect(row.confirmed_at).toBeTruthy()
      expect(requests(mock(), "PUT", CONFIRMS)).toHaveLength(1)
      await job("print-trail-sweep")
      await job("print-trail-sweep")
      expect(requests(mock(), "PUT", CONFIRMS)).toHaveLength(1)
      // The SKU-only stock refresh.
      await waitFor(async () => (await variantOf(seed.variants.ptZero)).stocked === 0, { what: "ptZero at 0 in Medusa" })
      expect((await eventsFor(container(), orderId)).map((e) => e.message)).toContain(
        `Print Trail accepted the order with a back-order: ${SKUS.ptZero} out of stock`
      )
    })

    it("a product going live without stock shows as a back-order within one sweep", async () => {
      const { orderId, row } = await confirmedOrder([{ variantId: seed.variants.preOrder, quantity: 1 }])
      expect(row.attention).toBeNull()
      const before = mock().state.requests.length
      // Live with no stock: Print Trail sends only stock-level-updated.
      await mock().setSkuStatus(SKUS.preOrder, "active")
      await rowWhere(orderId, "a refetch queued by the stock event", (r) => r.pending_action === "refetch")
      await job("print-trail-sweep")
      const flagged = await rowWhere(orderId, "back-order attention", (r) => r.attention === "pt-fulfilment-back-order")
      expect(flagged.fulfilments[0].backOrderReason).toBe("out-of-stock")
      const messages = (await eventsFor(container(), orderId)).map((e) => e.message)
      expect(messages.some((m) => /is now out of stock \(the product went live before its stock arrived\)$/.test(m))).toBe(true)
      // No reconcile poll was needed.
      expect(mock().state.requests.slice(before).some((r) => r.method === "GET" && /\/orders\?/.test(r.path))).toBe(false)
    })

    it("a SKU that went pre-order after the last stock run is still re-read on activation", async () => {
      // The stock run in beforeEach saw pt2 active, so only the confirm (and
      // the sync) can record it as seen on pre-order.
      mock().state.skuStatus[SKUS.pt2] = "pre-order"
      const { orderId, row } = await confirmedOrder([{ variantId: seed.variants.pt2, quantity: 1 }])
      expect(row.attention).toBeNull()
      expect(row.fulfilments[0]).toMatchObject({ status: "back-order", backOrderReason: "pre-order" })
      expect(await printTrail(container()).preOrderSeen([SKUS.pt2])).toEqual([SKUS.pt2])
      // Live with no stock: only stock-level-updated.
      mock().state.stock[SKUS.pt2] = 0
      await mock().setSkuStatus(SKUS.pt2, "active")
      await rowWhere(orderId, "a refetch queued by the stock event", (r) => r.pending_action === "refetch")
      await job("print-trail-sweep")
      await rowWhere(orderId, "back-order attention", (r) => r.attention === "pt-fulfilment-back-order")
    })

    // Print Trail keeps it held as pre-order until the product goes active;
    // only stock-level-updated says so.
    it("a product set inactive while an order waits shows on the order, as dismissable attention", async () => {
      const { orderId } = await confirmedOrder([{ variantId: seed.variants.preOrder, quantity: 1 }])
      mock().state.stock[SKUS.preOrder] = 5
      await mock().setSkuStatus(SKUS.preOrder, "inactive")
      await rowWhere(orderId, "a refetch queued by the stock event", (r) => r.pending_action === "refetch")
      await job("print-trail-sweep")
      const flagged = await rowWhere(orderId, "inactive-product attention", (r) => r.attention === "pt-pre-order-inactive")
      expect(flagged.fulfilments[0]).toMatchObject({ status: "back-order", backOrderReason: "pre-order" })
      const { data: view } = await api.get(`/admin/print-trail/orders/${orderId}`, admin)
      expect(view.rows[0].fulfilments[0]).toMatchObject({ back_order: "pre-order", product_inactive: true })
      expect(view.rows[0].actions.dismiss).toBe(true)
      // Active again: released, and the attention goes.
      await mock().setSkuStatus(SKUS.preOrder, "active")
      await rowWhere(orderId, "the released fulfilment", (r) => r.fulfilments?.[0]?.status === "draft" && r.attention === null)
    })

    // No order webhook and no updatedAt change, so reconcile never sees it.
    it("an out-of-stock back-order whose product goes back on pre-order clears within one sweep", async () => {
      mock().state.backorderWarehouse = true
      mock().state.stock[SKUS.ptZero] = 0
      const { orderId } = await placeOrder(api, seed, [{ variantId: seed.variants.ptZero, quantity: 1 }])
      await rowWhere(orderId, "back-order attention", (r) => r.attention === "pt-fulfilment-back-order")
      await mock().setSkuStatus(SKUS.ptZero, "pre-order")
      await rowWhere(orderId, "a refetch queued by the stock event", (r) => r.pending_action === "refetch")
      await job("print-trail-sweep")
      const cleared = await rowWhere(orderId, "the attention cleared", (r) => r.attention === null && r.fulfilments?.[0]?.backOrderReason === "pre-order")
      expect(cleared.fulfilments[0].status).toBe("back-order")
      expect((await eventsFor(container(), orderId)).map((e) => e.message)).toContainEqual(
        expect.stringMatching(/is waiting for the pre-order release again \(its product is no longer active\)$/)
      )
    })

    it("the settings page reports the API version", async () => {
      const version = await waitFor(async () => {
        const { data } = await api.get("/admin/print-trail/connection", admin)
        return data.api_version?.version ? data.api_version : undefined
      }, { what: "the stored API version" })
      expect(version.version).toBe("1.3.0")
    })

    // 0.1.x on Medusa 2.19+ left a deleted key out of the write, which
    // A store upgraded from 0.2.0 (or 0.1.x): the SKU checks and backorder
    // reasons are still in variant metadata, which store routes return, with
    // no print_trail_variant rows; and 0.1.x on Medusa 2.19+ left a
    // pre-order flag on a variant it then forgot. One full stock sync moves
    // the checks into rows and the reasons into stock_backordered, and
    // deletes the keys, leaving the store's own and print_trail_sku alone.
    it("the first full stock sync after upgrading moves the plugin's keys out of variant metadata", async () => {
      const service = printTrail(container())
      const at = "2026-10-01T00:00:00.000Z"
      const legacy = (sku: string, status: string) => ({ sku, status, checked_at: at })
      const { pt, pt2, pod, preOrder, unknownSku, plain } = seed.variants
      const seeded: Record<string, Record<string, unknown>> = {
        [pt]: { print_trail_sku: SKUS.pt, print_trail_sku_check: legacy(SKUS.pt, "matched") },
        [unknownSku]: { print_trail_sku_check: legacy(SKUS.unknownSku, "not-found") },
        // Tracked: the marker is its reason.
        [pod]: { print_trail_backorder: true },
        [preOrder]: { print_trail_backorder: "pre-order" },
        // Untracked, with the store's own backorder on.
        [pt2]: { print_trail_backorder: true },
        // Outside Print Trail's profiles.
        [plain]: { print_trail_pre_order: "2020-01-01" },
      }
      for (const [id, keys] of Object.entries(seeded)) {
        await updateProductVariantsWorkflow(container()).run({
          input: {
            product_variants: [
              { id, ...(id === pt2 ? { allow_backorder: true } : {}), metadata: { ...(await variantOf(id)).metadata, store_key: "kept", ...keys } },
            ],
          },
        })
      }
      // The saves' SKU checks (each finds the legacy check current), then
      // 0.2.0's state: no rows, a record without reasons, the SKU check's
      // notice, and a completed scan.
      await settleSkuChecks(container())
      await service.forgetVariants({ variantIds: Object.keys(seeded) })
      await service.setState("stock_backordered", { ids: [pod, preOrder].sort() })
      await service.setState("sku_check_unmatched", { skus: [SKUS.unknownSku] })
      await service.setState("variant_metadata_scan", { after: "zzz", scanned: 9, preOrderFields: 0, markers: 0, startedAt: at, updatedAt: at, completedAt: at })
      expect(await variantOf(pt)).toMatchObject({ metadata: expect.objectContaining({ print_trail_sku_check: legacy(SKUS.pt, "matched") }) })

      await stockJob()
      for (const id of Object.keys(seeded)) {
        const { metadata } = await variantOf(id)
        expect(metadata).not.toHaveProperty("print_trail_sku_check")
        expect(metadata).not.toHaveProperty("print_trail_backorder")
        expect(metadata).toMatchObject({ store_key: "kept" })
      }
      expect((await variantOf(pt)).metadata).toMatchObject({ print_trail_sku: SKUS.pt })
      expect((await variantOf(plain)).preOrder).toBeUndefined()
      // In scope, the run keeps the pre-order flag right.
      expect((await variantOf(preOrder)).preOrder).toBe(PRE_ORDER_DATE)

      // The checks are rows, adopted from metadata, and the variant view shows them.
      const rows = await service.variantRows([pt, unknownSku])
      expect(rows.get(pt)).toMatchObject({ check_sku: SKUS.pt, check_status: "matched", check_source: "metadata" })
      expect(rows.get(unknownSku)).toMatchObject({ check_status: "not-found", check_source: "metadata" })
      expect((await api.get(`/admin/print-trail/variants/${pt}`, admin)).data).toMatchObject({
        check: { sku: SKUS.pt, status: "matched" },
        check_current: true,
      })
      // sku_check_unmatched is gone, and the notice still lists the SKU.
      expect(await service.getState("sku_check_unmatched")).toBeNull()
      expect((await api.get("/admin/print-trail/sku-health", admin)).data.unmatched).toContain(SKUS.unknownSku)

      // Reasons in the record; the untracked backorder left on and unclaimed.
      expect(await service.getState("stock_backordered")).toEqual({
        ids: [pod, preOrder].sort(),
        reasons: { [pod]: "print-on-demand", [preOrder]: "pre-order" },
      })
      expect(await variantOf(pt2)).toMatchObject({ allowBackorder: true })
      expect(await viewStock(pt2)).toMatchObject({ print_on_demand: false, pre_order_backorder: false })
      expect(await viewStock(pod)).toMatchObject({ print_on_demand: true })

      expect(await service.getState("variant_metadata_scan")).toMatchObject({
        version: 2,
        markers: 3,
        checks: 2,
        preOrderFields: 1,
        completedAt: expect.any(String),
      })
    })

    // The harness has fewer variants than a page, so the scan above never
    // sends the cursor. Paging one variant at a time checks the id $gt
    // filter and the id order on the real database.
    it("the metadata scan's pages follow the cursor on Postgres", async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { listPluginMetadata } = require(path.resolve(__dirname, "../../.medusa/server/src/workflows/steps/stock-context.js"))
      const query = container().resolve(ContainerRegistrationKeys.QUERY)
      const { data } = await query.graph({ entity: "product_variant", fields: ["id"], pagination: { order: { id: "ASC" } } })
      const all = (data as { id: string }[]).map((v) => v.id)
      expect(all.length).toBeGreaterThan(2)
      const read: string[] = []
      let after: string | null = null
      // Bounded, so a filter that's ignored fails instead of looping.
      for (let i = 0; i <= all.length; i++) {
        const page: { lastId: string | null; read: number } = await listPluginMetadata(query, after, 1)
        if (!page.read) break
        read.push(page.lastId!)
        after = page.lastId
      }
      expect(read).toEqual(all)
    })

    // Version 2 over the real catalogue, one variant per page: the legacy
    // check is adopted and deleted, the record completes, and every variant
    // is read once.
    it("the version 2 scan pages through every variant on Postgres", async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { scanPluginMetadata } = require(path.resolve(__dirname, "../../.medusa/server/src/lib/stock-flow.js"))
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { buildStockContext } = require(path.resolve(__dirname, "../../.medusa/server/src/workflows/steps/stock-context.js"))
      const service = printTrail(container())
      const { plain } = seed.variants
      const check = { sku: "HAR-PLAIN", status: "not-found", checked_at: "2026-10-01T00:00:00.000Z" }
      await updateProductVariantsWorkflow(container()).run({
        input: { product_variants: [{ id: plain, metadata: { ...(await variantOf(plain)).metadata, print_trail_sku_check: check } }] },
      })
      await settleSkuChecks(container())
      await service.setState("variant_metadata_scan", null)
      const query = container().resolve(ContainerRegistrationKeys.QUERY)
      const { data } = await query.graph({ entity: "product_variant", fields: ["id"], pagination: { order: { id: "ASC" } } })

      const ctx = await buildStockContext(container())
      await scanPluginMetadata(ctx, { inScope: null, ptProducts: null, startedAt: new Date() }, { pageSize: 1, maxPages: data.length + 1, deadlineMs: 300_000 })
      expect(await service.getState("variant_metadata_scan")).toMatchObject({
        version: 2,
        scanned: data.length,
        checks: 1,
        completedAt: expect.any(String),
      })
      expect((await variantOf(plain)).metadata).not.toHaveProperty("print_trail_sku_check")
      // Outside Print Trail's profiles, but the scope was unknown: adopted.
      expect((await service.variantRows([plain])).get(plain)).toMatchObject({ check_sku: "HAR-PLAIN", check_status: "not-found", check_source: "metadata" })
    })
  },
})
