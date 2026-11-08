import path from "node:path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import jwt from "jsonwebtoken"
import { HARNESS, useMock } from "./harness"
import { adminHeaders, type Headers } from "./helpers/admin"
import { runJob } from "./helpers/jobs"
import { CONFIRMS, POSTS, printTrail, requests, rowFor } from "./helpers/rows"
import { seedStore, type Seed } from "./helpers/seed"
import { placeOrder } from "./helpers/store"
import { waitFor } from "./helpers/wait"

jest.setTimeout(120_000)

const mock = useMock()

// Settings → Print Trail: values saved in the admin over the plugin options.
medusaIntegrationTestRunner({
  cwd: path.join(__dirname, "app"),
  testSuite: ({ api, getContainer, utils }) => {
    let seed: Seed
    let admin: Headers
    let adminId: string
    const container = () => getContainer()
    const get = () => api.get("/admin/print-trail/settings", admin)
    const ALL = ["prefix-may-repeat", "confirms-awaiting-payment"]
    const save = (values: Record<string, unknown>, confirm?: string[]) =>
      api.post("/admin/print-trail/settings", confirm === undefined ? { values } : { values, confirm }, admin)
    const reset = (key: string, confirm: string[] = []) =>
      api.delete(`/admin/print-trail/settings/${key}${confirm.length ? `?confirm=${confirm.join(",")}` : ""}`, admin)
    const setting = async (key: string) => (await get()).data.settings.find((s: { key: string }) => s.key === key)
    const refused = async (p: Promise<unknown>) => {
      try {
        await p
      } catch (e) {
        return (e as { response?: { status: number } }).response?.status
      }
      return 200
    }
    const placed = async () => {
      const { orderId, displayId } = await placeOrder(api, seed, [{ variantId: seed.variants.pt, quantity: 1 }])
      const row = await waitFor(async () => rowFor(container(), orderId), { what: "a Print Trail row" })
      return { orderId, displayId, row }
    }

    beforeAll(async () => {
      seed = await seedStore(container())
      admin = await adminHeaders(container())
      adminId = (jwt.decode(admin.headers.authorization.replace(/^Bearer /, "")) as { actor_id: string }).actor_id
    })

    afterEach(async () => {
      for (const key of ["orderNumberPrefix", "confirmOn"]) await reset(key, ALL)
    })

    it("a prefix saved in the admin numbers the next order, and a reset goes back to the plugin options", async () => {
      const before = await setting("orderNumberPrefix")
      expect(before).toMatchObject({ value: HARNESS.prefix, config: HARNESS.prefix, source: "config", changed_by: null })

      const { data } = await save({ orderNumberPrefix: "WEB-" })
      expect(data.status).toBe("saved")
      const saved = await setting("orderNumberPrefix")
      expect(saved).toMatchObject({ value: "WEB-", config: HARNESS.prefix, source: "admin", changed_by: { id: adminId } })
      expect(Date.parse(saved.changed_at)).toBeGreaterThan(Date.now() - 60_000)

      const { displayId, row } = await placed()
      expect(row.pt_order_number).toBe(`WEB-${displayId}`)

      const { data: resetDone } = await reset("orderNumberPrefix")
      expect(resetDone).toMatchObject({ status: "saved", keys: ["orderNumberPrefix"], warnings: [] })
      expect(await setting("orderNumberPrefix")).toMatchObject({ value: HARNESS.prefix, source: "config", changed_by: { id: adminId } })
      const next = await placed()
      expect(next.row.pt_order_number).toBe(`${HARNESS.prefix}${next.displayId}`)
    })

    it("switching confirm on to order.placed confirms an order waiting for payment within one sweep, keeping its number", async () => {
      await save({ confirmOn: "payment.captured" })
      const { orderId, displayId } = await placed()
      const waiting = await waitFor(async () => {
        const r = await rowFor(container(), orderId)
        return r?.block_reason === "awaiting-payment" ? r : undefined
      }, { what: "a row waiting for payment" })
      expect(waiting).toMatchObject({ confirmed_at: null, pending_action: null, pt_order_number: `${HARNESS.prefix}${displayId}` })

      await save({ orderNumberPrefix: "NEW-" })
      // Still waiting: the sweep leaves it to the capture under payment.captured.
      await runJob(container(), "print-trail-sweep", utils.waitWorkflowExecutions)
      expect((await rowFor(container(), orderId)).confirmed_at).toBeNull()

      // A switch with no time recorded, as a change in the plugin options
      // makes: the sweep leaves the order for its Resend.
      const service = printTrail(container())
      await service.setState("setting:confirmOn", { overridden: true, value: "order.placed", changed_by: null, changed_at: new Date().toISOString() })
      await service.invalidateOptions()
      await runJob(container(), "print-trail-sweep", utils.waitWorkflowExecutions)
      expect((await rowFor(container(), orderId)).confirmed_at).toBeNull()
      await save({ confirmOn: "payment.captured" })

      // The switch asks first, with how many orders it will confirm.
      const { data: asked } = await save({ confirmOn: "order.placed" })
      expect(asked).toEqual({ status: "needs-confirmation", reason: "confirms-awaiting-payment", count: 1 })
      expect((await setting("confirmOn")).value).toBe("payment.captured")
      // A confirm for another question doesn't cover this one.
      expect((await save({ confirmOn: "order.placed" }, ["prefix-may-repeat"])).data.reason).toBe("confirms-awaiting-payment")
      expect((await save({ confirmOn: "order.placed" }, ["confirms-awaiting-payment"])).data.status).toBe("saved")
      mock().state.requests.length = 0
      await runJob(container(), "print-trail-sweep", utils.waitWorkflowExecutions)
      const confirmed = await rowFor(container(), orderId)
      expect(confirmed).toMatchObject({ block_reason: null, pt_order_number: `${HARNESS.prefix}${displayId}` })
      expect(confirmed.confirmed_at).not.toBeNull()
      expect(requests(mock(), "PUT", CONFIRMS)).toHaveLength(1)
      expect(requests(mock(), "POST", POSTS).map((r) => r.body.orderNumber)).toEqual([`${HARNESS.prefix}${displayId}`])

      // Confirmed once: the next sweep sends nothing.
      mock().state.requests.length = 0
      await runJob(container(), "print-trail-sweep", utils.waitWorkflowExecutions)
      expect(requests(mock(), "PUT", CONFIRMS)).toHaveLength(0)
    })

    it("a prefix that could repeat an order number already sent needs a confirm", async () => {
      await save({ orderNumberPrefix: "T9-" })
      const { displayId } = await placed()
      const { data: asked } = await save({ orderNumberPrefix: "T" })
      expect(asked).toEqual({ status: "needs-confirmation", reason: "prefix-may-repeat", numbers: [`T9-${displayId}`], partial: false })
      expect((await setting("orderNumberPrefix")).value).toBe("T9-")

      const { data: confirmed } = await save({ orderNumberPrefix: "T" }, ["prefix-may-repeat"])
      expect(confirmed.status).toBe("saved")
      expect((await setting("orderNumberPrefix")).value).toBe("T")
    })

    it("resetting the prefix checks the plugin options' prefix, ignoring case, and needs the same confirm", async () => {
      // HAR-9 + 12 is HAR-912, which order 912 would get under HAR-.
      await save({ orderNumberPrefix: "har-9" })
      const { displayId } = await placed()
      const { data: asked } = await reset("orderNumberPrefix")
      expect(asked).toEqual({ status: "needs-confirmation", reason: "prefix-may-repeat", numbers: [`har-9${displayId}`], partial: false })
      expect(await setting("orderNumberPrefix")).toMatchObject({ value: "har-9", source: "admin" })

      expect(await refused(reset("orderNumberPrefix", ["everything"]))).toBe(400)
      const { data: done } = await reset("orderNumberPrefix", ["prefix-may-repeat"])
      expect(done.status).toBe("saved")
      expect(await setting("orderNumberPrefix")).toMatchObject({ value: HARNESS.prefix, source: "config" })
    })

    it("refuses values it can't use, and any setting that isn't editable", async () => {
      expect(await refused(save({ orderNumberPrefix: "WEB 1" }))).toBe(400)
      expect(await refused(save({ "reconcile.lookbackDays": 0 }))).toBe(400)
      expect(await refused(save({ "notifications.adminEmail": ["ops@"] }))).toBe(400)
      expect(await refused(save({ defaultShippingMethod: "teleport" }))).toBe(400)
      expect(await refused(save({ stockLocationIds: ["sloc_missing"] }))).toBe(400)
      expect(await refused(save({ baseUrl: "https://elsewhere.example" }))).toBe(400)
      expect(await refused(save({ apiToken: "x" }))).toBe(400)
      expect(await refused(reset("apiToken"))).toBe(404)
      // A dotted key in the path.
      await save({ "reconcile.lookbackDays": 30 })
      expect(await setting("reconcile.lookbackDays")).toMatchObject({ value: 30, source: "admin" })
      expect(await refused(reset("reconcile.lookbackDays"))).toBe(200)
      expect(await setting("reconcile.lookbackDays")).toMatchObject({ value: 7, source: "config" })
      const { data } = await get()
      expect(data.settings.every((s: { source: string }) => s.source === "config")).toBe(true)
      expect(JSON.stringify(data)).not.toContain(HARNESS.token)
    })
  },
})
