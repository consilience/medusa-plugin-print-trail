import http from "node:http"
import type { AddressInfo } from "node:net"
import { startMockPrintTrail, type MockPrintTrail } from "../../../../dev/mock-print-trail"
import { resolvePluginOptions, type RawPrintTrailPluginOptions } from "../../../config"
import {
  DEFAULT_RETRY_DELAYS_MS,
  DEFAULT_TIMEOUT_MS,
  PrintTrailClient,
  STATUS_CLIENT_TUNING,
} from "../../../modules/printTrail/client/client"
import { API_VERSION_STATE_KEY } from "../../api-version"
import { AUTH_FAILED_STATE_KEY, CHANNEL_INACTIVE_STATE_KEY, createAuthTracker } from "../../auth-state"
import { STATE_KEYS } from "../../stock"
import { TEAM_CODE_STATE_KEY } from "../../team-code"
import { readWebhookSecrets, WEBHOOK_SECRET_STATE_KEY } from "../../webhook-secret"
import {
  connectionStatus,
  refreshWebhookSecret,
  SecretLockBusyError,
  WEBHOOK_SECRET_LOCK,
  WEBHOOK_SECRET_LOCK_SECONDS,
  withSecretLock,
  registerWebhook,
  rotateSecret,
  testConnection,
  type ConnectionDeps,
} from "../connection"

jest.setTimeout(20000)

const TOKEN = "connection-test-token-1a2b"
const SECRET = "webhook-secret-value-9z8y"
const CHANNEL = "acme-medusa1"

const memoryState = (initial: Record<string, unknown> = {}) => {
  const map = new Map<string, unknown>(Object.entries(initial))
  const writes: string[] = []
  return {
    map,
    writes,
    async getState<T>(key: string): Promise<T | null> {
      return (map.get(key) as T | undefined) ?? null
    },
    async setState(key: string, value: unknown) {
      writes.push(key)
      map.set(key, value)
    },
  }
}

let mock: MockPrintTrail
beforeEach(async () => {
  mock = await startMockPrintTrail({ token: TOKEN, channelId: CHANNEL })
})
afterEach(async () => mock.close())

const deps = (
  over: { options?: RawPrintTrailPluginOptions; token?: string; state?: ReturnType<typeof memoryState>; count?: number } = {}
): ConnectionDeps & { state: ReturnType<typeof memoryState> } => {
  const options = resolvePluginOptions({
    baseUrl: mock.url,
    channelId: CHANNEL,
    apiToken: over.token ?? TOKEN,
    webhookSecret: SECRET,
    backendUrl: "https://shop.example.com",
    adminUrl: "https://shop.example.com/app",
    appUrl: "https://app.example.com",
    notifications: { adminEmail: "ops@example.com" },
    ...over.options,
  })
  const state = over.state ?? memoryState()
  const onStatus = createAuthTracker(state, null)
  const make = (tuning = {}) =>
    options.apiToken && options.baseUrl && options.channelId
      ? new PrintTrailClient({ baseUrl: options.baseUrl, channelId: options.channelId, apiToken: options.apiToken, retryDelays: [0], onStatus, ...tuning })
      : null
  return {
    options,
    client: make(),
    statusClient: make(STATUS_CLIENT_TUNING),
    state,
    locking: { provider: "redis", postgresConfigured: false, supported: true },
    ptShippingOptionCount: 1,
    env: {},
  }
}

const settle = () => new Promise((r) => setTimeout(r, 30))
const posts = () => mock.state.requests.filter((r) => r.method === "POST" && r.path.endsWith("/webhooks"))

describe("connection status", () => {
  it("reports a healthy connection with names, links and webhook state", async () => {
    const view = await connectionStatus(deps())
    expect(view.configured).toBe(true)
    expect(view.diagnosis).toEqual({ ok: true, teamCode: "acme", channelCode: "medusa1", channelId: CHANNEL })
    expect(view.channel).toEqual({ name: "Test channel", code: "medusa1", url: "https://app.example.com/acme/settings/channels" })
    expect(view.team).toEqual({ name: "Testing", code: "acme", url: "https://app.example.com/acme/settings/team" })
    expect(view.webhook).toEqual({
      state: "not-registered",
      registeredUrl: null,
      targetUrl: "https://shop.example.com/hooks/print-trail",
      warnings: [],
    })
    expect(view.shippingMethodsSource).toBe("print-trail")
    expect(view.shippingMethods.map((m) => m.code)).toEqual(["standard", "express", "air", "tracked"])
    expect(view.credentials).toEqual({
      channelId: CHANNEL,
      apiToken: { set: true, ending: "1a2b" },
      // The secret never shows any of its characters.
      webhookSecret: { set: true, ending: null, source: "configured" },
    })
    expect(view.options.notifications.adminEmailCount).toBe(1)
    expect(view.schedules).toHaveLength(3)
    expect(view.warnings).toEqual([])
    expect(view.health).toEqual({ reconnect: false, channelInactive: false, unmatchedSkus: 0 })
  })

  it("status never registers", async () => {
    const d = deps()
    await connectionStatus(d)
    await settle()
    expect(posts()).toHaveLength(0)
    expect(d.state.writes).toEqual([])
  })

  it("shows the stored API version", async () => {
    const state = memoryState({ [API_VERSION_STATE_KEY]: { version: "1.2.0", seenAt: "2026-10-19T11:00:00.000Z" } })
    expect((await connectionStatus(deps({ state }))).api_version).toEqual({ version: "1.2.0", seen_at: "2026-10-19T11:00:00.000Z" })
    expect((await connectionStatus(deps())).api_version).toBeNull()
    // Junk is not a version.
    const junk = memoryState({ [API_VERSION_STATE_KEY]: { version: 12 } })
    expect((await connectionStatus(deps({ state: junk }))).api_version).toBeNull()
  })

  it("reports health from auth_failed and both unmatched lists", async () => {
    const state = memoryState({
      [AUTH_FAILED_STATE_KEY]: { at: "x", path: "/orders" },
      [STATE_KEYS.unmatched]: { skus: ["A"] },
      [STATE_KEYS.skuCheckUnmatched]: { skus: ["B"] },
    })
    const view = await connectionStatus(deps({ state, token: "wrong" }))
    expect(view.health).toEqual({ reconnect: true, channelInactive: false, unmatchedSkus: 2 })
  })

  it("falls back to the four methods when Print Trail is unreachable", async () => {
    mock.fail(/token$/, 503, undefined, 9)
    const view = await connectionStatus(deps())
    expect(view.diagnosis).toEqual({ ok: false, code: "unreachable" })
    expect(view.shippingMethodsSource).toBe("fallback")
    expect(view.shippingMethods.map((m) => m.code)).toEqual(["standard", "express", "air", "tracked"])
    expect(mock.state.requests.some((r) => r.path.endsWith("/shipping-methods"))).toBe(false)
  })

  it("keeps the token's codes when the channel can't be read", async () => {
    mock.fail(/channels\/[^/]+$/, 503, undefined, 9)
    const view = await connectionStatus(deps())
    expect(view.diagnosis.ok).toBe(true)
    expect(view.channel).toEqual({ name: null, code: "medusa1", url: "https://app.example.com/acme/settings/channels" })
    expect(view.webhook.state).toBe("unknown")
  })

  it("shows a store with no credentials as not connected, with no API call", async () => {
    const view = await connectionStatus(deps({ options: { baseUrl: undefined, channelId: undefined, apiToken: undefined } }))
    expect(view.configured).toBe(false)
    expect(view.diagnosis).toEqual({ ok: false, code: "not-configured" })
    expect(view.webhook.state).toBe("unknown")
    expect(view.shippingMethodsSource).toBe("fallback")
    expect(view.warnings).toContain("not-configured")
    expect(mock.state.requests).toHaveLength(0)
  })

  it("answers within the status timeout when Print Trail hangs", async () => {
    const hung = http.createServer(() => {
      // Never answers.
    })
    await new Promise<void>((r) => hung.listen(0, "127.0.0.1", r))
    const url = `http://127.0.0.1:${(hung.address() as AddressInfo).port}`
    try {
      const d = deps({ options: { baseUrl: url } })
      const getChannel = jest.spyOn(d.statusClient!, "getChannel")
      const started = Date.now()
      const view = await connectionStatus(d)
      expect(Date.now() - started).toBeLessThan(7000)
      expect(view.diagnosis).toEqual({ ok: false, code: "unreachable" })
      expect(getChannel).not.toHaveBeenCalled()
    } finally {
      hung.closeAllConnections()
      await new Promise((r) => hung.close(r))
    }
  })
})

describe("test connection and webhook registration", () => {
  it("test connection stores the team code and registers a missing webhook", async () => {
    const d = deps()
    const result = await testConnection(d)
    expect(result.diagnosis.ok).toBe(true)
    expect(result.webhook).toEqual({ action: "registered", state: "registered", warnings: [] })
    expect(mock.state.webhookUrl).toBe("https://shop.example.com/hooks/print-trail")
    expect(d.state.map.get(TEAM_CODE_STATE_KEY)).toMatchObject({ teamCode: "acme", channelCode: "medusa1", channelId: CHANNEL })
  })

  it("an inactive channel (API 1.2.0): diagnosed, recorded, and cleared once it works again", async () => {
    const d = deps()
    mock.fail(/\/token$/, 403, { type: "https://docs.printtrail.com/channel-api/problems/channel-inactive", title: "Channel inactive", status: 403, detail: "This channel is inactive in Print Trail." })
    const result = await testConnection(d)
    expect(result.diagnosis).toEqual({ ok: false, code: "channel-inactive" })
    expect(result.webhook.action).toBe("cannot-register")
    await settle()
    expect(d.state.map.get(CHANNEL_INACTIVE_STATE_KEY)).toMatchObject({ path: "/token" })
    mock.fail(/\/token$/, 403, { type: "https://docs.printtrail.com/channel-api/problems/channel-inactive", title: "Channel inactive", status: 403, detail: "This channel is inactive in Print Trail." })
    const view = await connectionStatus(d)
    expect(view.diagnosis).toEqual({ ok: false, code: "channel-inactive" })
    expect(view.health).toMatchObject({ channelInactive: true, reconnect: false })
    // Any success means the channel is active again.
    expect((await connectionStatus(d)).diagnosis.ok).toBe(true)
    await settle()
    expect(d.state.map.get(CHANNEL_INACTIVE_STATE_KEY)).toBeNull()
  })

  it("test connection clears an inactive channel another process recorded", async () => {
    const state = memoryState({ [CHANNEL_INACTIVE_STATE_KEY]: { at: "x", path: "/orders" } })
    const d = deps({ state })
    d.client = new PrintTrailClient({ baseUrl: mock.url, channelId: CHANNEL, apiToken: TOKEN, retryDelays: [0] })
    d.statusClient = new PrintTrailClient({ baseUrl: mock.url, channelId: CHANNEL, apiToken: TOKEN, retryDelays: [] })
    expect((await testConnection(d)).diagnosis.ok).toBe(true)
    expect(state.map.get(CHANNEL_INACTIVE_STATE_KEY)).toBeNull()
  })

  it("test connection clears an auth failure another process recorded", async () => {
    const state = memoryState({ [AUTH_FAILED_STATE_KEY]: { at: "x", path: "/orders" } })
    const d = deps({ state })
    // This process's tracker read the flag as unset before the worker set it.
    d.client = new PrintTrailClient({ baseUrl: mock.url, channelId: CHANNEL, apiToken: TOKEN, retryDelays: [0] })
    expect((await testConnection(d)).diagnosis.ok).toBe(true)
    expect(state.map.get(AUTH_FAILED_STATE_KEY)).toBeNull()
  })

  it("test connection diagnoses with the short-timeout client and registers with the normal one", async () => {
    const d = deps()
    const slowToken = jest.spyOn(d.client!, "getToken")
    const quickToken = jest.spyOn(d.statusClient!, "getToken")
    const register = jest.spyOn(d.client!, "registerWebhook")
    expect((await testConnection(d)).webhook.action).toBe("registered")
    expect(quickToken).toHaveBeenCalledTimes(1)
    expect(slowToken).not.toHaveBeenCalled()
    expect(register).toHaveBeenCalledTimes(1)
  })

  it("test connection asks before replacing a URL that points elsewhere, and leaves a matching one", async () => {
    const elsewhere = "https://other-store.example/hooks/printtrail/{notificationType}"
    mock.state.webhookUrl = elsewhere
    const d = deps()
    expect((await testConnection(d)).webhook).toEqual({
      action: "needs-confirmation",
      state: "elsewhere",
      warnings: [],
      registeredUrl: elsewhere,
    })
    expect(posts()).toHaveLength(0)
    expect(mock.state.webhookUrl).toBe(elsewhere)
    expect((await registerWebhook(d, { force: true })).action).toBe("registered")
    expect(mock.state.webhookUrl).toBe("https://shop.example.com/hooks/print-trail")
    mock.state.webhookUrl = "HTTPS://shop.example.com/hooks/print-trail/"
    const before = posts().length
    expect((await testConnection(deps())).webhook).toEqual({ action: "already-registered", state: "registered", warnings: [] })
    // Posted again for the secret, with the same (normalised) URL.
    expect(posts()).toHaveLength(before + 1)
    expect(mock.state.webhookUrl).toBe("https://shop.example.com/hooks/print-trail")
  })

  it("registers nothing when the channel can't be read", async () => {
    mock.fail(/channels\/[^/]+$/, 503, undefined, 9)
    const result = await testConnection(deps())
    expect(result.webhook.action).toBe("cannot-register")
    expect(result.webhook.state).toBe("unknown")
    expect(posts()).toHaveLength(0)
  })

  it("asks before registering a local or plain-http URL", async () => {
    const d = deps({ options: { backendUrl: "http://localhost:9000" } })
    const result = await testConnection(d)
    expect(result.webhook).toEqual({ action: "needs-confirmation", state: "not-registered", warnings: ["not-https", "local-address"] })
    expect(posts()).toHaveLength(0)
    expect((await registerWebhook(d, { force: false })).action).toBe("needs-confirmation")
    expect(posts()).toHaveLength(0)
    const forced = await registerWebhook(d, { force: true })
    expect(forced.action).toBe("registered")
    expect(mock.state.webhookUrl).toBe("http://localhost:9000/hooks/print-trail")
  })

  it("says when the registered URL is one Print Trail 1.2.0+ won't deliver to", async () => {
    const d = deps({ options: { backendUrl: "http://shop.example.com" } })
    mock.state.webhookUrl = "http://shop.example.com/hooks/print-trail"
    const view = await connectionStatus(d)
    expect(view.webhook).toMatchObject({ state: "registered", warnings: ["not-https", "undeliverable"] })
    expect((await testConnection(d)).webhook).toMatchObject({ action: "already-registered", warnings: ["not-https", "undeliverable"] })
  })

  it("refuses locally a URL Print Trail never accepts, without calling it", async () => {
    const d = deps({ options: { backendUrl: `https://shop.example.com/${"a".repeat(200)}` } })
    const result = await testConnection(d)
    expect(result.webhook).toMatchObject({ action: "invalid-url", warnings: ["too-long"] })
    expect(posts()).toHaveLength(0)
  })

  it("reports API 1.2.0's webhook URL 422 with the rule it broke", async () => {
    mock.fail(/webhooks$/, 422, {
      type: "about:blank",
      status: 422,
      title: "Validation errors",
      violations: [{ property: "url", message: "The url is not allowed: The webhook host \"shop.example.com\" does not resolve. Webhook URLs must be https on a public host." }],
    })
    const result = await testConnection(deps())
    expect(result.webhook).toMatchObject({ action: "failed", detail: expect.stringContaining("does not resolve") })
  })

  it("reports a failed registration with Print Trail's detail", async () => {
    mock.fail(/webhooks$/, 422, { status: 422, title: "Invalid", detail: "The url must be https" })
    const result = await testConnection(deps())
    expect(result.webhook).toMatchObject({ action: "failed", state: "not-registered", detail: "The url must be https" })
  })

  it("diagnoses a wrong token without registering", async () => {
    const d = deps({ token: "wrong-token" })
    const result = await testConnection(d)
    expect(result.diagnosis).toEqual({ ok: false, code: "token-invalid" })
    expect(result.webhook.action).toBe("cannot-register")
    await settle()
    expect(d.state.map.get(AUTH_FAILED_STATE_KEY)).toMatchObject({ path: "/token" })
    expect(d.state.map.has(TEAM_CODE_STATE_KEY)).toBe(false)
    expect(posts()).toHaveLength(0)
  })

  it("does nothing for a store with no credentials", async () => {
    const d = deps({ options: { baseUrl: undefined, channelId: undefined, apiToken: undefined } })
    expect(await testConnection(d)).toEqual({
      diagnosis: { ok: false, code: "not-configured" },
      webhook: { action: "cannot-register", state: "unknown", warnings: [] },
    })
    expect((await registerWebhook(d, { force: true })).action).toBe("cannot-register")
    expect(mock.state.requests).toHaveLength(0)
  })

  it("stores the secret Print Trail returns on register", async () => {
    const d = deps()
    expect((await testConnection(d)).webhook.action).toBe("registered")
    expect(await readWebhookSecrets(d.state, d.options, new Date())).toEqual({
      secrets: ["mock-secret"],
      source: "print-trail",
      mismatch: true,
    })
    const view = await connectionStatus(d)
    expect(view.credentials.webhookSecret).toEqual({ set: true, ending: null, source: "print-trail" })
    expect(view.warnings).toContain("webhook-secret-mismatch")
    expect(JSON.stringify(view)).not.toContain("mock-secret")
  })

  it("test connection re-fetches the secret when the URL is already registered", async () => {
    const d = deps({ options: { webhookSecret: undefined } })
    await testConnection(d)
    // Rotated in the Print Trail app, behind the plugin.
    mock.state.webhookSecret = "rotated-in-the-app"
    const before = posts().length
    const result = await testConnection(d)
    expect(result.webhook).toEqual({ action: "already-registered", state: "registered", warnings: [] })
    expect(posts()).toHaveLength(before + 1)
    const now = new Date()
    expect((await readWebhookSecrets(d.state, d.options, now)).secrets).toEqual(["rotated-in-the-app", "mock-secret"])
    expect((await connectionStatus(d)).warnings).not.toContain("webhook-secret-mismatch")
  })

  it("a failed re-post leaves an already-registered webhook as it was", async () => {
    mock.state.webhookUrl = "https://shop.example.com/hooks/print-trail"
    mock.fail(/webhooks$/, 422, { status: 422, title: "Invalid", detail: "nope" })
    const d = deps()
    expect((await testConnection(d)).webhook).toEqual({
      action: "already-registered",
      state: "registered",
      warnings: [],
      detail: "secret-not-stored",
    })
    expect(d.state.map.has(WEBHOOK_SECRET_STATE_KEY)).toBe(false)
  })

  it("says so when Print Trail registered or rotated but the secret couldn't be stored", async () => {
    const d = deps()
    const failing = { ...d.state, setState: async () => { throw new Error("db down") } }
    const broken = { ...d, state: failing }
    expect((await registerWebhook(broken, { force: true }))).toMatchObject({ action: "registered", detail: "secret-not-stored" })
    expect(await rotateSecret(broken)).toEqual({ action: "failed", detail: "secret-not-stored" })
  })

  it("old Print Trail API: no secret returned, the configured one stays in use", async () => {
    mock.state.legacy = true
    const d = deps()
    expect((await testConnection(d)).webhook.action).toBe("registered")
    expect(d.state.map.has(WEBHOOK_SECRET_STATE_KEY)).toBe(false)
    expect((await connectionStatus(d)).credentials.webhookSecret.source).toBe("configured")
    const none = deps({ options: { webhookSecret: undefined } })
    await testConnection(none)
    const view = await connectionStatus(none)
    expect(view.credentials.webhookSecret).toEqual({ set: false, ending: null, source: null })
    expect(view.warnings).toContain("no-webhook-secret")
  })

  it("never returns the token or the secret, even in a failure", async () => {
    const leaks = (v: unknown) => {
      const json = JSON.stringify(v)
      return json.includes(TOKEN) || json.includes(SECRET)
    }
    expect(leaks(await connectionStatus(deps()))).toBe(false)
    expect(leaks(await testConnection(deps()))).toBe(false)
    mock.fail(/token$/, 418, { detail: `token ${TOKEN} and ${SECRET}` }, 1)
    const status = await connectionStatus(deps())
    expect(status.diagnosis).toMatchObject({ ok: false, code: "error" })
    expect(leaks(status)).toBe(false)
    mock.fail(/token$/, 500, `<p>Bearer ${TOKEN}</p>`, 9)
    expect(leaks(await connectionStatus(deps()))).toBe(false)
    expect(leaks(await testConnection(deps()))).toBe(false)
  })

  it("scrubs a stored secret from a failure's detail", async () => {
    const d = deps({ options: { webhookSecret: undefined } })
    await testConnection(d) // stores "mock-secret"
    mock.fail(/token$/, 418, { detail: "echo mock-secret" }, 1)
    const status = await connectionStatus(d)
    expect(JSON.stringify(status)).not.toContain("mock-secret")
    mock.state.webhookUrl = null
    mock.fail(/webhooks$/, 422, { status: 422, title: "Invalid", detail: "secret mock-secret" })
    const result = await registerWebhook(d, { force: true })
    expect(result).toMatchObject({ action: "failed" })
    expect(JSON.stringify(result)).not.toContain("mock-secret")
  })

  it("rotates and keeps the old secret for the grace window", async () => {
    const d = deps({ options: { webhookSecret: undefined } })
    await testConnection(d)
    const before = mock.state.webhookSecret
    const result = await rotateSecret(d)
    expect(result).toEqual({ action: "rotated" })
    expect(JSON.stringify(result)).not.toContain(mock.state.webhookSecret)
    expect(mock.state.webhookSecret).not.toBe(before)
    const now = new Date()
    expect((await readWebhookSecrets(d.state, d.options, now)).secrets).toEqual([mock.state.webhookSecret, before])
    expect((await readWebhookSecrets(d.state, d.options, new Date(now.getTime() + 4 * 3600_000 + 60_000))).secrets).toEqual([mock.state.webhookSecret])
  })

  it("won't rotate a channel registered elsewhere, or not registered", async () => {
    const d = deps()
    expect(await rotateSecret(d)).toEqual({ action: "not-registered" })
    mock.state.webhookUrl = "https://other.example/hooks"
    expect(await rotateSecret(d)).toEqual({ action: "not-registered" })
    expect(mock.state.requests.filter((r) => r.path.endsWith("/rotate"))).toHaveLength(0)
    expect(mock.state.webhookSecret).toBe("mock-secret")
  })

  it("a 404 from the rotate route is unsupported unless the channel is unknown", async () => {
    mock.state.webhookUrl = "https://shop.example.com/hooks/print-trail"
    const d = deps()
    mock.fail(/\/rotate$/, 404, { type: "about:blank", title: "Not Found", status: 404, detail: "The route could not be found." })
    expect(await rotateSecret(d)).toEqual({ action: "unsupported" })
    mock.fail(/\/rotate$/, 404, { type: "about:blank", title: "Not Found", status: 404, detail: `The channel ID "${CHANNEL}" does not exist` })
    expect(await rotateSecret(d)).toMatchObject({ action: "failed" })
    // API 1.2.0: an unknown channel is a 401, which is never "unsupported".
    mock.fail(/\/rotate$/, 401, { type: "about:blank", title: "Unauthorized", status: 401, detail: "Unauthenticated." })
    expect(await rotateSecret(d)).toEqual({ action: "failed", detail: "Print Trail refused the API token or channel ID" })
  })

  it("an older Print Trail API can't rotate", async () => {
    mock.state.legacy = true
    const d = deps()
    await testConnection(d)
    expect(await rotateSecret(d)).toEqual({ action: "unsupported" })
    expect(d.state.map.has(WEBHOOK_SECRET_STATE_KEY)).toBe(false)
  })

  it("a register racing a rotate never leaves the older secret current", async () => {
    // One process's mutex standing in for the Locking Module.
    let tail: Promise<unknown> = Promise.resolve()
    const lock = <T,>(fn: () => Promise<T>): Promise<T> => {
      const run = tail.then(fn, fn)
      tail = run.catch(() => undefined)
      return run
    }
    const d = { ...deps({ options: { webhookSecret: undefined } }), lock }
    await testConnection(d) // registered here, "mock-secret" stored
    // The register's response (the old secret) is slow to be stored.
    const real = d.client!.registerWebhook.bind(d.client!)
    jest.spyOn(d.client!, "registerWebhook").mockImplementation(async (url) => {
      const result = await real(url)
      await new Promise((r) => setTimeout(r, 50))
      return result
    })
    await Promise.all([testConnection(d), new Promise((r) => setTimeout(r, 10)).then(() => rotateSecret(d))])
    const { secrets } = await readWebhookSecrets(d.state, d.options, new Date())
    expect(secrets[0]).toBe(mock.state.webhookSecret)
  })

  describe("refreshWebhookSecret (the sweep's self-heal)", () => {
    const later = (d: ConnectionDeps, ms: number) => ({ ...d, now: () => new Date(Date.now() + ms) })

    it("refetches a secret that a new API token made unreadable", async () => {
      const state = memoryState()
      const old = deps({ options: { webhookSecret: undefined }, state, token: TOKEN })
      await testConnection(old) // stored under TOKEN
      // Same channel, a new token: the stored secret no longer decrypts.
      mock.state.requests.length = 0
      const fresh = { ...old, options: { ...old.options, apiToken: "a-new-token-value-5678" } }
      expect((await readWebhookSecrets(state, fresh.options, new Date())).source).toBeNull()
      expect(await refreshWebhookSecret(fresh)).toBe("stored")
      expect(posts()).toHaveLength(1)
      expect((await readWebhookSecrets(state, fresh.options, new Date())).secrets).toEqual(["mock-secret"])
      // Readable now: the next run posts nothing.
      expect(await refreshWebhookSecret(fresh)).toBe("readable")
      expect(posts()).toHaveLength(1)
    })

    it("never registers a channel that sends elsewhere, and backs off", async () => {
      mock.state.webhookUrl = "https://other.example/hooks"
      const d = deps({ options: { webhookSecret: undefined } })
      expect(await refreshWebhookSecret(d)).toBe("not-registered")
      expect(posts()).toHaveLength(0)
      expect(mock.state.webhookUrl).toBe("https://other.example/hooks")
      expect(await refreshWebhookSecret(d)).toBe("cooling-down")
      // A channel that sends elsewhere is looked at once a day.
      expect(await refreshWebhookSecret(later(d, 16 * 60_000))).toBe("cooling-down")
      expect(await refreshWebhookSecret(later(d, 25 * 3600_000))).toBe("not-registered")
    })

    it("an older Print Trail API: one post, then a day's wait", async () => {
      mock.state.legacy = true
      mock.state.webhookUrl = "https://shop.example.com/hooks/print-trail"
      const d = deps({ options: { webhookSecret: undefined } })
      expect(await refreshWebhookSecret(d)).toBe("unsupported")
      expect(await refreshWebhookSecret(later(d, 60 * 60_000))).toBe("cooling-down")
      expect(posts()).toHaveLength(1)
      expect(await refreshWebhookSecret(later(d, 25 * 3600_000))).toBe("unsupported")
      expect(posts()).toHaveLength(2)
    })

    it("a readable secret takes no lock", async () => {
      const d = deps({ options: { webhookSecret: undefined } })
      await testConnection(d)
      const lock = jest.fn(<T,>(fn: () => Promise<T>) => fn())
      expect(await refreshWebhookSecret({ ...d, lock: lock as never })).toBe("readable")
      expect(lock).not.toHaveBeenCalled()
    })

    it("does nothing without credentials", async () => {
      const d = deps({ options: { baseUrl: undefined, channelId: undefined, apiToken: undefined } })
      expect(await refreshWebhookSecret(d)).toBe("not-configured")
      expect(mock.state.requests).toHaveLength(0)
    })
  })

  it("the secret lock outlives the slowest register or rotate", () => {
    // Every attempt times out, with every retry: per call, then two calls
    // (the channel read, then the register or rotate).
    const perCall = DEFAULT_TIMEOUT_MS * (DEFAULT_RETRY_DELAYS_MS.length + 1) + DEFAULT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)
    expect(WEBHOOK_SECRET_LOCK_SECONDS * 1000).toBeGreaterThan(2 * perCall)
  })

  describe("the webhook-secret lock", () => {
    // The in-memory provider's rules: acquire throws while another owner holds the key.
    const fakeLocking = () => {
      const held = new Map<string, { ownerId: string | null; expire?: number }>()
      return {
        held,
        async acquire(key: string | string[], args?: { ownerId?: string | null; expire?: number }) {
          const k = String(key)
          const lock = held.get(k)
          if (lock && lock.ownerId !== (args?.ownerId ?? null)) throw new Error(`Failed to acquire lock for key "${k}"`)
          held.set(k, { ownerId: args?.ownerId ?? null, expire: args?.expire })
        },
        async release(key: string | string[], args?: { ownerId?: string | null }) {
          const k = String(key)
          if (held.get(k)?.ownerId === (args?.ownerId ?? null)) held.delete(k)
          return true
        },
      }
    }

    it("holds the lock with the long expiry and releases it", async () => {
      const locking = fakeLocking()
      const seen: unknown[] = []
      const out = await withSecretLock(locking as never, async () => {
        seen.push(locking.held.get(WEBHOOK_SECRET_LOCK)?.expire)
        return "ran"
      })
      expect(out).toBe("ran")
      expect(seen).toEqual([WEBHOOK_SECRET_LOCK_SECONDS])
      expect(locking.held.size).toBe(0)
    })

    it("waits briefly, then reports busy without running", async () => {
      const locking = fakeLocking()
      locking.held.set(WEBHOOK_SECRET_LOCK, { ownerId: "someone-else" })
      const fn = jest.fn(async () => "ran")
      await expect(withSecretLock(locking as never, fn, { waitMs: 60, pollMs: 10 })).rejects.toBeInstanceOf(SecretLockBusyError)
      expect(fn).not.toHaveBeenCalled()
      setTimeout(() => locking.held.delete(WEBHOOK_SECRET_LOCK), 30)
      await expect(withSecretLock(locking as never, fn, { waitMs: 500, pollMs: 10 })).resolves.toBe("ran")
    })

    it("a busy lock is a friendly result for Test connection, Re-register and Rotate", async () => {
      const busy = <T,>(): Promise<T> => Promise.reject(new SecretLockBusyError())
      const d = { ...deps(), lock: busy }
      const tested = await testConnection(d)
      expect(tested.diagnosis.ok).toBe(true)
      expect(tested.webhook).toMatchObject({ action: "busy" })
      expect((await registerWebhook(d, { force: true })).action).toBe("busy")
      expect(await rotateSecret(d)).toEqual({ action: "busy" })
      expect(posts()).toHaveLength(0)
    })

    it("the sweep's refresh honours the lock", async () => {
      mock.state.webhookUrl = "https://shop.example.com/hooks/print-trail"
      const order: string[] = []
      let tail: Promise<unknown> = Promise.resolve()
      const lock = <T,>(fn: () => Promise<T>): Promise<T> => {
        order.push("lock")
        const run = tail.then(fn, fn)
        tail = run.catch(() => undefined)
        return run
      }
      const d = { ...deps({ options: { webhookSecret: undefined } }), lock }
      expect(await refreshWebhookSecret(d)).toBe("stored")
      expect(order).toEqual(["lock"])
      // Busy: no Print Trail call, and a busy result rather than a throw.
      const before = mock.state.requests.length
      const busyDeps = { ...deps({ options: { webhookSecret: undefined }, state: memoryState() }), lock: <T,>(): Promise<T> => Promise.reject(new SecretLockBusyError()) }
      expect(await refreshWebhookSecret(busyDeps)).toBe("busy")
      expect(mock.state.requests.length).toBe(before)
    })
  })
})
