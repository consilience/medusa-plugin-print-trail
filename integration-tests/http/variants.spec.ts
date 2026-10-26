// A variant's SKU check and what the store sees: the unmatched-SKU notice
// after variants are deleted, the check following Print Trail's status
// through the stock sync, and store routes without the plugin's own keys.
import path from "node:path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createProductsWorkflow } from "@medusajs/medusa/core-flows"
import { HARNESS, PRE_ORDER_DATE, PRE_ORDER_MOCK, SKUS, useMock } from "./harness"
import { adminHeaders, type Headers } from "./helpers/admin"
import { runJob, stockJob as runStockJob, webhookStockRun as waitForWebhookStockRun } from "./helpers/jobs"
import { printTrail, requests, rowFor } from "./helpers/rows"
import { seedStore, settleSkuChecks, softDeleteVariantQuietly, type Seed } from "./helpers/seed"
import { placeOrder } from "./helpers/store"
import { waitFor } from "./helpers/wait"

jest.setTimeout(120_000)

const mock = useMock(PRE_ORDER_MOCK)
const HOOK = `${HARNESS.backendUrl}/hooks/print-trail`
const VALIDATE = /\/products\/validate-skus$/

medusaIntegrationTestRunner({
  cwd: path.join(__dirname, "app"),
  testSuite: ({ api, getContainer, dbConnection, utils }) => {
    let seed: Seed
    let admin: Headers
    const container = () => getContainer()
    const stockJob = () => runStockJob(container(), utils.waitWorkflowExecutions)
    const sweep = () => runJob(container(), "print-trail-sweep", utils.waitWorkflowExecutions)

    const unmatched = async () => ((await api.get("/admin/print-trail/sku-health", admin)).data.unmatched as string[]).slice().sort()
    const checkOf = async (variantId: string) => (await api.get(`/admin/print-trail/variants/${variantId}`, admin)).data.check
    const rowWhere = (orderId: string, what: string, test: (r: any) => boolean) =>
      waitFor(async () => {
        const r = await rowFor(container(), orderId)
        return r && test(r) ? r : undefined
      }, { what })
    const productOf = async (variantId: string) => {
      const query = container().resolve(ContainerRegistrationKeys.QUERY)
      const { data } = await query.graph({ entity: "product_variant", fields: ["product_id"], filters: { id: variantId } })
      return (data[0] as any).product_id as string
    }

    beforeAll(async () => {
      seed = await seedStore(container())
      admin = await adminHeaders(container())
    })

    beforeEach(async () => {
      await stockJob()
    })

    it("a deleted variant's SKU leaves the notice", async () => {
      // Two more Print Trail variants with SKUs Print Trail doesn't list.
      const {
        result: [withdrawn],
      } = await createProductsWorkflow(container()).run({
        input: {
          products: [
            {
              title: "Harness Book Withdrawn",
              handle: "harness-withdrawn",
              status: "published",
              shipping_profile_id: seed.ptProfileId,
              sales_channels: [{ id: seed.salesChannelId }],
              options: [{ title: "Format", values: ["Paperback", "Hardback"] }],
              variants: [
                { title: "Paperback", sku: "HAR-WITHDRAWN-1", options: { Format: "Paperback" }, prices: [{ currency_code: "gbp", amount: 10 }] },
                { title: "Hardback", sku: "HAR-WITHDRAWN-2", options: { Format: "Hardback" }, prices: [{ currency_code: "gbp", amount: 15 }] },
              ],
            },
          ],
        },
      })
      await settleSkuChecks(container())
      expect(await checkOf(seed.variants.unknownSku)).toMatchObject({ sku: SKUS.unknownSku, status: "not-found" })
      expect(await unmatched()).toEqual([SKUS.unknownSku, "HAR-WITHDRAWN-1", "HAR-WITHDRAWN-2"].sort())
      const { orderId } = await placeOrder(api, seed, [{ variantId: seed.variants.pt, quantity: 1 }])
      await rowWhere(orderId, "a confirmed row", (r) => !!r.confirmed_at)
      const orderHealth = async () => (await api.get(`/admin/print-trail/orders/${orderId}`, admin)).data.health
      expect(await orderHealth()).toMatchObject({ unmatchedSkus: 3 })

      // Deleted in the admin: gone from the notice with no job run.
      const [first, second] = withdrawn.variants as any[]
      const withdrawnSku = (v: any) => v.sku as string
      await api.delete(`/admin/products/${withdrawn.id}/variants/${first.id}`, admin)
      await waitFor(async () => !(await unmatched()).includes(withdrawnSku(first)), { what: "the deleted variant's SKU gone" })
      expect(await unmatched()).toEqual([SKUS.unknownSku, withdrawnSku(second)].sort())
      expect(await orderHealth()).toMatchObject({ unmatchedSkus: 2 })

      // A deleted product takes its variants' SKUs with it.
      await api.delete(`/admin/products/${withdrawn.id}`, admin)
      await waitFor(async () => !(await unmatched()).includes(withdrawnSku(second)), { what: "the deleted product's SKU gone" })
      expect(await unmatched()).toEqual([SKUS.unknownSku])
      expect((await printTrail(container()).variantRows([first.id, second.id])).size).toBe(0)

      // A SKU the last stock sync also listed (Print Trail has no stock
      // level for it) loses its check at once, and leaves the notice with the
      // next full stock sync.
      expect((await printTrail(container()).getState("unmatched_skus")).skus).toContain(SKUS.unknownSku)
      await api.delete(`/admin/products/${await productOf(seed.variants.unknownSku)}/variants/${seed.variants.unknownSku}`, admin)
      await waitFor(async () => (await printTrail(container()).variantRows([seed.variants.unknownSku])).size === 0, { what: "the check forgotten" })
      expect(await printTrail(container()).notFoundSkus()).toEqual([])
      await stockJob()
      expect(await unmatched()).toEqual([])
      expect(await orderHealth()).toMatchObject({ unmatchedSkus: 0 })
    })

    it("a full stock sync forgets a variant deleted without an event", async () => {
      const { unknownSku } = seed.variants
      expect(await unmatched()).toContain(SKUS.unknownSku)
      await softDeleteVariantQuietly(dbConnection, unknownSku)
      // No event, so nothing has forgotten it yet.
      expect((await printTrail(container()).variantRows([unknownSku])).size).toBe(1)
      expect(await unmatched()).toContain(SKUS.unknownSku)

      await stockJob()
      expect((await printTrail(container()).variantRows([unknownSku])).size).toBe(0)
      expect(await unmatched()).not.toContain(SKUS.unknownSku)
    })

    it("the variant badge follows the stock sync", async () => {
      mock().state.webhookUrl = HOOK
      const { pt } = seed.variants
      expect(await checkOf(pt)).toMatchObject({ sku: SKUS.pt, status: "matched" })
      const validations = requests(mock(), "POST", VALIDATE).length

      // stock-level-updated runs a full sync, which takes the status from
      // the stock levels.
      const { completedAt } = await printTrail(container()).getState("stock_last_run")
      await mock().setSkuStatus(SKUS.pt, "pre-order")
      await waitForWebhookStockRun(container(), completedAt, utils.waitWorkflowExecutions)
      expect(await checkOf(pt)).toMatchObject({ sku: SKUS.pt, status: "pre-order" })

      // Back to active. (The mock's changedAt has whole seconds, so this
      // second event can fall to the watermark; the job stands in for it.)
      await mock().setSkuStatus(SKUS.pt, "active")
      await stockJob()
      expect(await checkOf(pt)).toMatchObject({ sku: SKUS.pt, status: "matched" })

      // The stock levels said so: no SKU was validated again, the pre-order
      // flag's metadata writes included.
      await settleSkuChecks(container())
      expect(requests(mock(), "POST", VALIDATE)).toHaveLength(validations)
    })

    it("a SKU Print Trail starts listing is re-checked and its blocked order sent", async () => {
      const { unknownSku } = seed.variants
      const { orderId } = await placeOrder(api, seed, [{ variantId: unknownSku, quantity: 1 }])
      await rowWhere(orderId, "unmatched-skus", (r) => r.attention === "unmatched-skus")

      // Print Trail starts listing it (no webhook: the store has none
      // registered here).
      await mock().restock(SKUS.unknownSku, 5)
      await stockJob()
      await sweep()

      const row = await rowWhere(orderId, "the order sent", (r) => !!r.confirmed_at)
      expect(row.attention).toBeNull()
      expect(await checkOf(unknownSku)).toMatchObject({ sku: SKUS.unknownSku, status: "matched" })
      expect(await unmatched()).not.toContain(SKUS.unknownSku)
    })

    it("store routes carry no internal plugin metadata", async () => {
      // A SKU check, after beforeEach's stock job.
      const before = requests(mock(), "POST", VALIDATE).length
      await api.post(
        `/admin/products/${await productOf(seed.variants.unknownSku)}/variants/${seed.variants.unknownSku}`,
        { sku: "HAR-UNKNOWN-2" },
        admin
      )
      await settleSkuChecks(container())
      expect(requests(mock(), "POST", VALIDATE).length).toBeGreaterThan(before)

      const h = { headers: { "x-publishable-api-key": seed.publishableKey } }
      const { data } = await api.get("/store/products?limit=50", h)
      const variants = (data.products as any[]).flatMap((p) => p.variants as any[])
      expect(variants.map((v) => v.id)).toEqual(expect.arrayContaining(Object.values(seed.variants)))
      for (const v of variants) {
        expect(v.metadata ?? {}).not.toHaveProperty("print_trail_sku_check")
        expect(v.metadata ?? {}).not.toHaveProperty("print_trail_backorder")
      }
      // The store-facing flag is still there, and the print-on-demand and
      // pre-order backorders are on.
      expect(variants.find((v) => v.id === seed.variants.preOrder).metadata).toMatchObject({ print_trail_pre_order: PRE_ORDER_DATE })
      expect(await printTrail(container()).getState("stock_backordered")).toMatchObject({
        reasons: { [seed.variants.pod]: "print-on-demand", [seed.variants.preOrder]: "pre-order" },
      })
    })
  },
})
