import path from "node:path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { HARNESS, useMock } from "./harness"
import { adminHeaders, type Headers } from "./helpers/admin"
import { runJob } from "./helpers/jobs"
import { eventsFor, printTrail, requests, rowFor, updateRow } from "./helpers/rows"
import { seedStore, type Seed } from "./helpers/seed"
import { backdateOrder, createOrderDirect, placeOrder } from "./helpers/store"
import { waitFor } from "./helpers/wait"

jest.setTimeout(120_000)

const mock = useMock()
const WEBHOOKS = /\/webhooks$/

medusaIntegrationTestRunner({
  cwd: path.join(__dirname, "app"),
  testSuite: ({ api, getContainer, dbConnection, utils }) => {
    let seed: Seed
    let admin: Headers
    const container = () => getContainer()
    const get = (p: string) => api.get(`/admin/print-trail${p}`, admin)
    const post = (p: string, body: unknown = {}) => api.post(`/admin/print-trail${p}`, body, admin)
    const confirmedOrder = async (variantId: string) => {
      const { orderId } = await placeOrder(api, seed, [{ variantId, quantity: 1 }])
      const row = await waitFor(async () => {
        const r = await rowFor(container(), orderId)
        return r?.confirmed_at ? r : undefined
      }, { what: "a confirmed row" })
      return { orderId, row }
    }

    beforeAll(async () => {
      seed = await seedStore(container())
      admin = await adminHeaders(container())
    })

    it("a regenerated token shows reconnect", async () => {
      mock().fail(/.*/, 401, { type: "about:blank", title: "Unauthorized", status: 401, detail: "Unauthenticated." }, 99)
      const { orderId } = await createOrderDirect(container(), seed, [{ variantId: seed.variants.pt, quantity: 1 }])
      await backdateOrder(dbConnection, orderId, 10)
      await runJob(container(), "print-trail-sweep", utils.waitWorkflowExecutions)

      const { data: broken } = await get("/connection")
      expect(broken.health.reconnect).toBe(true)
      expect(broken.diagnosis).toMatchObject({ ok: false, code: "token-invalid" })

      mock().reset()
      const { data: tested } = await post("/connection")
      expect(tested.diagnosis.ok).toBe(true)
      const { data: fixed } = await get("/connection")
      expect(fixed.health.reconnect).toBe(false)
    })

    it("[API 1.2.0] an inactive channel: the order waits, the jobs only probe, and it goes through once active", async () => {
      mock().state.channelInactive = true
      // order.placed sends it; Print Trail refuses.
      const { orderId } = await placeOrder(api, seed, [{ variantId: seed.variants.pt, quantity: 1 }])
      const waiting = await waitFor(async () => {
        const r = await rowFor(container(), orderId)
        return r?.attention === "channel-inactive" ? r : undefined
      }, { what: "a row waiting on the inactive channel" })
      expect(waiting).toMatchObject({ pending_action: "send", confirmed_at: null })
      expect(waiting.attempts?.send ?? 0).toBe(0)
      await waitFor(async () => ((await get("/connection")).data.health.channelInactive ? true : undefined), {
        what: "the recorded inactive channel",
      })

      // While it's inactive, each job run makes one probe and nothing else,
      // even with the row due.
      await updateRow(container(), { id: waiting.id, next_attempt_at: new Date(Date.now() - 1000) })
      mock().state.requests.length = 0
      await runJob(container(), "print-trail-sweep", utils.waitWorkflowExecutions)
      await runJob(container(), "print-trail-reconcile", utils.waitWorkflowExecutions)
      expect(mock().state.requests.map((r) => `${r.method} ${r.path.replace(/^\/v1\/channels\/[^/]+/, "")}`)).toEqual([
        "GET /token",
        "GET /token",
      ])
      expect((await rowFor(container(), orderId)).attempts?.send ?? 0).toBe(0)

      // Active again: the next sweep's probe passes, clears the flag and runs the send.
      mock().state.channelInactive = false
      await runJob(container(), "print-trail-sweep", utils.waitWorkflowExecutions)
      const done = await waitFor(async () => {
        const r = await rowFor(container(), orderId)
        return r?.confirmed_at ? r : undefined
      }, { what: "the order confirmed once the channel is active" })
      expect(done.attention).toBeNull()
      expect((await get("/connection")).data.health.channelInactive).toBe(false)
    })

    it("[API 1.2.0] a sweep that hears a refusal stops: one refused request, not one per due row", async () => {
      const ids: string[] = []
      for (let i = 0; i < 5; i++) {
        const { orderId } = await createOrderDirect(container(), seed, [{ variantId: seed.variants.pt, quantity: 1 }])
        await backdateOrder(dbConnection, orderId, 10)
        ids.push(orderId)
      }
      mock().fail(/.*/, 401, { type: "about:blank", title: "Unauthorized", status: 401, detail: "Unauthenticated." }, 99)
      mock().state.requests.length = 0
      await runJob(container(), "print-trail-sweep", utils.waitWorkflowExecutions)
      expect(mock().state.requests).toHaveLength(1)
      // Put right for the tests after.
      mock().reset()
      await post("/connection")
    })

    it("[API 1.2.0] the sweep does nothing but probe while access is refused", async () => {
      const { orderId } = await createOrderDirect(container(), seed, [{ variantId: seed.variants.pt, quantity: 1 }])
      await backdateOrder(dbConnection, orderId, 10)
      await printTrail(container()).setState("auth_failed", { at: new Date().toISOString(), path: "/orders" })
      mock().fail(/.*/, 401, { type: "about:blank", title: "Unauthorized", status: 401, detail: "Unauthenticated." }, 99)
      mock().state.requests.length = 0
      await runJob(container(), "print-trail-sweep", utils.waitWorkflowExecutions)
      expect(mock().state.requests.map((r) => r.path.replace(/^\/v1\/channels\/[^/]+/, ""))).toEqual(["/token"])
      expect(await rowFor(container(), orderId)).toBeUndefined()
      mock().reset()
      await post("/connection")
    })

    it("test connection registers this store's webhook only when asked", async () => {
      await get("/connection")
      expect(requests(mock(), "POST", WEBHOOKS)).toHaveLength(0)

      const { data: tested } = await post("/connection")
      // The harness backend is http://localhost: not https, and local.
      expect(tested.webhook.action).toBe("needs-confirmation")
      expect(requests(mock(), "POST", WEBHOOKS)).toHaveLength(0)

      const { data: forced } = await post("/webhook", { force: true })
      expect(forced.webhook?.action ?? forced.action).toBe("registered")
      expect(mock().state.webhookUrl).toBe(`${HARNESS.backendUrl}/hooks/print-trail`)
    })

    it("never returns the token or the webhook secret", async () => {
      const bodies = [
        JSON.stringify((await get("/connection")).data),
        JSON.stringify((await post("/connection")).data),
      ]
      for (const body of bodies) {
        expect(body).not.toContain(HARNESS.token)
        expect(body).not.toContain(HARNESS.webhookSecret)
      }
    })

    it("the order view links each Print Trail order", async () => {
      await post("/connection") // stores the team code the link is built from
      const { orderId, row } = await confirmedOrder(seed.variants.pt)
      const { data } = await get(`/orders/${orderId}`)
      expect(data.rows).toHaveLength(1)
      expect(data.rows[0].pt_url).toMatch(new RegExp(`/acme/orders/${row.pt_uuid}$`))
    })

    it("the attention list shows a blocked order", async () => {
      const { orderId } = await placeOrder(api, seed, [{ variantId: seed.variants.unknownSku, quantity: 1 }])
      await waitFor(async () => (await rowFor(container(), orderId))?.attention === "unmatched-skus", {
        what: "unmatched-skus",
      })
      const { data } = await get("/attention")
      expect(data.rows.map((r: any) => r.order_id)).toContain(orderId)
      expect(data.rows.find((r: any) => r.order_id === orderId).attention).toBe("unmatched-skus")
    })

    it("a dismissed final Print Trail code stays dismissed until Print Trail's order changes", async () => {
      const { orderId, row } = await confirmedOrder(seed.variants.pt)
      const refresh = () => post(`/orders/${orderId}/refresh`)
      const current = async () => {
        const r = await rowFor(container(), orderId)
        return { attention: r?.attention ?? null, dismissed_attention: r?.dismissed_attention ?? null }
      }
      const pt = mock().state.orders.get(row.pt_uuid)
      const parcels = pt.fulfilments.map((f: any) => f.status)
      // Print Trail marks every parcel returned with the order.
      mock().setStatus(row.pt_uuid, "returned")
      expect(pt.fulfilments.every((f: any) => f.status === "returned")).toBe(true)
      await refresh()
      expect(await current()).toEqual({ attention: "pt-returned", dismissed_attention: null })
      const { data: view } = await get(`/orders/${orderId}`)
      expect(view.rows[0].actions.dismiss).toBe(true)
      expect((await get("/attention")).data.rows.find((r: any) => r.order_id === orderId).dismissable).toBe(true)

      const { data: dismissed } = await post(`/orders/${orderId}/dismiss`, { print_trail_order_id: row.id, attention: "pt-returned" })
      expect(dismissed.status).toBe("dismissed")
      expect((await eventsFor(container(), orderId)).map((e) => e.kind)).toContain("attention-dismissed")

      // Print Trail still has it returned: the sync raises neither the order
      // nor its returned parcels again.
      await refresh()
      const kept = await current()
      expect(kept.attention).toBeNull()
      expect(kept.dismissed_attention).toMatch(new RegExp(`^${row.pt_uuid}\\|pt-returned,pt-fulfilment-returned`))

      // Print Trail's order moves on: forgotten, and raised afresh if it returns.
      mock().setStatus(row.pt_uuid, "processing")
      pt.fulfilments.forEach((f: any, i: number) => (f.status = parcels[i]))
      await refresh()
      expect(await current()).toEqual({ attention: null, dismissed_attention: null })
      mock().setStatus(row.pt_uuid, "returned")
      await refresh()
      expect(await current()).toEqual({ attention: "pt-returned", dismissed_attention: null })
    })

    it("the rate-card guard rejects a bad card", async () => {
      const descending = {
        method: "tracked",
        currency_code: "gbp",
        bands: [
          { max_weight: 2000, prices: { gbp: 6.5 } },
          { max_weight: 1000, prices: { gbp: 3.95 } },
        ],
      }
      const bad = await api.post(`/admin/shipping-options/${seed.ptOptionId}`, { data: descending }, {
        ...admin,
        validateStatus: () => true,
      })
      expect(bad.status).toBe(400)

      // Medusa's own form sends the provider's fulfilment option as data.
      const form = await api.post(
        `/admin/shipping-options/${seed.ptOptionId}`,
        { data: { id: "print-trail", name: "Print Trail", method: "tracked" } },
        { ...admin, validateStatus: () => true }
      )
      expect(form.status).toBe(200)
    })
  },
})
