import path from "node:path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { assertLocalPrintTrail, HARNESS, useMock } from "./harness"
import { adminHeaders, type Headers } from "./helpers/admin"
import { seedStore, type Seed } from "./helpers/seed"
import { placeOrder } from "./helpers/store"

jest.setTimeout(120_000)

useMock()

medusaIntegrationTestRunner({
  cwd: path.join(__dirname, "app"),
  testSuite: ({ api, getContainer }) => {
    let seed: Seed
    let admin: Headers

    beforeAll(async () => {
      seed = await seedStore(getContainer())
      admin = await adminHeaders(getContainer())
    })

    it("fixture refuses a non-local Print Trail host", () => {
      expect(() => assertLocalPrintTrail("https://api.printtrail.com")).toThrow(/refusing/)
      expect(() => assertLocalPrintTrail("http://localhost:4310")).toThrow(/refusing/)
      expect(() => assertLocalPrintTrail(undefined)).toThrow(/refusing/)
      expect(() => assertLocalPrintTrail(HARNESS.baseUrl)).not.toThrow()
    })

    it("boots with the plugin loaded", async () => {
      expect((await api.get("/health")).status).toBe(200)
      const hook = await api.post("/hooks/print-trail", { notificationType: "order-created" }, { validateStatus: () => true })
      expect(hook.status).toBe(401)
      await expect(getContainer().resolve<any>("printTrail").listPrintTrailOrders({})).resolves.toEqual([])
    })

    it("lists the Print Trail provider", async () => {
      const { data } = await api.get("/admin/fulfillment-providers", admin)
      expect(data.fulfillment_providers.map((p: any) => p.id)).toContain("print-trail_print-trail")
    })

    it("prices the Print Trail option from its rate card", async () => {
      const h = { headers: { "x-publishable-api-key": seed.publishableKey } }
      const {
        data: { cart },
      } = await api.post(
        "/store/carts",
        { region_id: seed.regionId, items: [{ variant_id: seed.variants.pt, quantity: 1 }] },
        h
      )
      const { data } = await api.post(
        `/store/shipping-options/${seed.ptOptionId}/calculate`,
        { cart_id: cart.id, data: {} },
        h
      )
      expect(data.shipping_option.amount).toBe(3.95)
    })

    it("places an order through the store API", async () => {
      const { displayId } = await placeOrder(api, seed, [
        { variantId: seed.variants.pt, quantity: 1 },
        { variantId: seed.variants.plain, quantity: 1 },
      ])
      expect(displayId).toEqual(expect.any(Number))
    })
  },
})
