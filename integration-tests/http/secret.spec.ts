import path from "node:path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { HARNESS, useMock } from "./harness"
import { adminHeaders, type Headers } from "./helpers/admin"
import { runJob } from "./helpers/jobs"
import { printTrail } from "./helpers/rows"

// No PRINT_TRAIL_WEBHOOK_SECRET: the secret comes only from the Print Trail API
// (1.1.0 and later), as it will for a merchant who copies just the channel id
// and the token.
process.env.PT_HARNESS_OPTIONS = JSON.stringify({ webhookSecret: null })

jest.setTimeout(120_000)

const mock = useMock()
const HOOK = `${HARNESS.backendUrl}/hooks/print-trail`

medusaIntegrationTestRunner({
  cwd: path.join(__dirname, "app"),
  testSuite: ({ api, getContainer, utils }) => {
    let admin: Headers
    const get = (p: string) => api.get(`/admin/print-trail${p}`, admin)
    const post = (p: string, body: unknown = {}) => api.post(`/admin/print-trail${p}`, body, admin)
    // A signed order event for an order this store doesn't know: 200
    // "ignored" once the signature verifies, 401 before.
    const deliver = (secret?: string) =>
      mock().sendWebhook("order-status-updated", undefined, {
        url: HOOK,
        ...(secret ? { secret } : {}),
        extra: { orderUuid: "00000000-0000-4000-8000-000000000000", orderNumber: "NOT-OURS" },
      })

    beforeAll(async () => {
      admin = await adminHeaders(getContainer())
    })

    it("a webhook is refused until Test connection has fetched the secret", async () => {
      expect((await deliver()).status).toBe(401)
      const { data: before } = await get("/connection")
      expect(before.credentials.webhookSecret).toEqual({ set: false, ending: null, source: null })
      expect(before.warnings).toContain("no-webhook-secret")

      // The harness URL is plain http on localhost, so registering needs the yes.
      const { data: registered } = await post("/webhook", { force: true })
      expect(registered.action).toBe("registered")
      expect((await deliver()).status).toBe(200)

      const { data: after } = await get("/connection")
      expect(after.credentials.webhookSecret).toEqual({ set: true, ending: null, source: "print-trail" })
      expect(after.warnings).not.toContain("no-webhook-secret")
      const tested = (await post("/connection")).data
      for (const body of [registered, after, tested]) {
        expect(JSON.stringify(body)).not.toContain(HARNESS.webhookSecret)
      }
    })

    it("after a rotate, the new secret works at once and the old one for the grace window", async () => {
      await post("/webhook", { force: true })
      const old = mock().state.webhookSecret
      const { data: rotated } = await post("/webhook/rotate")
      expect(rotated).toEqual({ action: "rotated" })
      const fresh = mock().state.webhookSecret
      expect(fresh).not.toBe(old)
      expect(JSON.stringify(rotated)).not.toContain(fresh)
      expect((await deliver(fresh)).status).toBe(200)
      expect((await deliver(old)).status).toBe(200)
      expect((await deliver("not-the-secret")).status).toBe(401)
    })

    it("a secret rotated in the Print Trail app is picked up by Test connection", async () => {
      await post("/webhook", { force: true })
      mock().state.webhookSecret = "b".repeat(64)
      expect((await deliver()).status).toBe(401)
      const { data } = await post("/connection")
      expect(data.webhook.action).toBe("already-registered")
      expect((await deliver()).status).toBe(200)
    })

    it("the sweep fetches the secret again when it can't read the stored one", async () => {
      await post("/webhook", { force: true })
      // As after a new API token: the sealed secret no longer decrypts.
      await printTrail(getContainer()).setState("webhook_secret", null)
      expect((await deliver()).status).toBe(401)
      await runJob(getContainer(), "print-trail-sweep", utils.waitWorkflowExecutions)
      expect((await deliver()).status).toBe(200)
      expect(mock().state.webhookUrl).toBe(HOOK)
    })

    it("an older Print Trail API returns no secret, so webhooks stay refused", async () => {
      mock().state.legacy = true
      const { data } = await post("/webhook", { force: true })
      expect(data.action).toBe("registered")
      expect((await deliver()).status).toBe(401)
      expect((await get("/connection")).data.credentials.webhookSecret.source).toBeNull()
      expect((await post("/webhook/rotate")).data).toEqual({ action: "unsupported" })
    })
  },
})
