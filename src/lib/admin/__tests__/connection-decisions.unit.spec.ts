import { resolvePluginOptions } from "../../../config"
import { PrintTrailApiError } from "../../../modules/printTrail/client/errors"
import type { RateCard } from "../../rate-card"
import type { SkuCheck } from "../../sku-check"
import type { SendOrderToPrintTrailInput } from "../../../workflows/send-order-to-print-trail"
import type { LockingCheck } from "../../locking-check"
import { printTrailAppPath } from "../../app-url"
import type { EndpointView, LockingView, RateCardDto, SendInputDto, SkuCheckDto } from "../../admin-types"
import {
  decideRegistration,
  diagnose,
  endpointInfo,
  healthView,
  lockingWarnings,
  maskSecret,
  normaliseWebhookUrl,
  settingsWarnings,
  webhookState,
  webhookTarget,
  webhookTargetWarnings,
  withDeliveryWarning,
} from "../connection-decisions"

// The admin's DTOs are structural copies of server types: these must stay assignable.
const _card: RateCardDto = {} as RateCard
const _check: SkuCheckDto = {} as SkuCheck
const _send: SendInputDto = {} as SendOrderToPrintTrailInput
const _endpoint: EndpointView = {} as ReturnType<typeof endpointInfo>
const _locking: LockingView = {} as LockingCheck
void [_card, _check, _send, _endpoint, _locking]

const apiError = (status: number, body: unknown = null, detail = "detail") =>
  new PrintTrailApiError(`Print Trail API GET /token → ${status}`, status, body, "GET", "/token", detail)

describe("connection decisions", () => {
  it("masks secrets to their last four characters", () => {
    expect(maskSecret(undefined)).toEqual({ set: false, ending: null })
    expect(maskSecret("")).toEqual({ set: false, ending: null })
    expect(maskSecret("abcdefgh1a2b")).toEqual({ set: true, ending: "1a2b" })
    expect(maskSecret("abcdefgh")).toEqual({ set: true, ending: null })
  })

  it("labels staging and production endpoints", () => {
    expect(endpointInfo("https://printtrail-core.consilstaging.com")).toEqual({
      url: "https://printtrail-core.consilstaging.com",
      environment: "staging",
    })
    expect(endpointInfo("https://staging.printtrail.example").environment).toBe("staging")
    expect(endpointInfo("https://api.printtrail.com").environment).toBe("production")
    expect(endpointInfo("http://127.0.0.1:4011").environment).toBe("other")
    expect(endpointInfo(undefined)).toEqual({ url: null, environment: null })
  })

  it("diagnoses token, channel and host failures in order", () => {
    expect(diagnose("acme-c", { teamCode: "acme", channelCode: "c", channelId: "acme-c" })).toEqual({
      ok: true,
      teamCode: "acme",
      channelCode: "c",
      channelId: "acme-c",
    })
    expect(diagnose("acme-c", apiError(401))).toEqual({ ok: false, code: "token-invalid" })
    // API 1.2.0: an inactive channel is refused on GET /token too.
    expect(diagnose("acme-c", apiError(403, { type: "https://docs.printtrail.com/channel-api/problems/channel-inactive", title: "Channel inactive", status: 403, detail: "This channel is inactive in Print Trail." }))).toEqual({ ok: false, code: "channel-inactive" })
    // A Standard-channel token: no type, Print Trail's detail says what to do.
    expect(diagnose("acme-c", apiError(403, { status: 403, detail: "Revoke it" }, "Revoke it"))).toEqual({
      ok: false,
      code: "error",
      detail: "Revoke it",
    })
    expect(diagnose("acme-c", apiError(404, { status: 404, detail: "Channel not found" }))).toEqual({
      ok: false,
      code: "channel-not-found",
    })
    expect(diagnose("acme-c", apiError(404, "<html>Not Found</html>"))).toEqual({ ok: false, code: "not-print-trail" })
    expect(diagnose("acme-c", apiError(0))).toEqual({ ok: false, code: "unreachable" })
    expect(diagnose("acme-c", apiError(503))).toEqual({ ok: false, code: "unreachable" })
    expect(diagnose("acme-c", apiError(422, null, "Bad thing"))).toEqual({ ok: false, code: "error", detail: "Bad thing" })
    expect(diagnose("acme-c", new Error("boom"))).toEqual({ ok: false, code: "error" })
  })

  it("diagnoses a token bound to another channel", () => {
    expect(diagnose("acme-c", { teamCode: "acme", channelCode: "d", channelId: "acme-d" })).toEqual({
      ok: false,
      code: "token-other-channel",
      tokenChannelId: "acme-d",
    })
  })

  it("normalises webhook URLs before comparing", () => {
    expect(normaliseWebhookUrl(" HTTPS://Shop.Example.com:443/hooks/print-trail/ ")).toBe(
      "https://shop.example.com/hooks/print-trail"
    )
    expect(normaliseWebhookUrl("http://shop.example.com:80/x")).toBe("http://shop.example.com/x")
    expect(normaliseWebhookUrl("https://shop.example.com:8443/x")).toBe("https://shop.example.com:8443/x")
    expect(normaliseWebhookUrl(" not a url// ")).toBe("not a url")
    expect(webhookTarget("https://shop.example.com")).toBe("https://shop.example.com/hooks/print-trail")
    expect(webhookTarget("https://shop.example.com/")).toBe("https://shop.example.com/hooks/print-trail")
    expect(webhookTarget(undefined)).toBeNull()
    const target = "https://shop.example.com/hooks/print-trail"
    expect(webhookState(null, target)).toEqual({ state: "unknown", registeredUrl: null })
    expect(webhookState({ webhookDetail: { uri: "x" } }, null)).toEqual({ state: "no-backend-url", registeredUrl: "x" })
    expect(webhookState({ webhookDetail: { uri: null } }, target)).toEqual({ state: "not-registered", registeredUrl: null })
    expect(webhookState({ webhookDetail: null }, target)).toEqual({ state: "not-registered", registeredUrl: null })
    expect(webhookState({ webhookDetail: { uri: "" } }, target).state).toBe("not-registered")
    expect(webhookState({ webhookDetail: { uri: "HTTPS://shop.example.com/hooks/print-trail/" } }, target)).toEqual({
      state: "registered",
      registeredUrl: "HTTPS://shop.example.com/hooks/print-trail/",
    })
  })

  it("treats another store's templated URL as elsewhere", () => {
    expect(
      webhookState(
        { webhookDetail: { uri: "https://other-store.example/hooks/printtrail/{notificationType}" } },
        "https://other-store.example/hooks/print-trail"
      ).state
    ).toBe("elsewhere")
  })

  it("warns about plain http and local or private hosts", () => {
    expect(webhookTargetWarnings("http://shop.example.com")).toEqual(["not-https"])
    expect(webhookTargetWarnings("https://localhost:9000")).toEqual(["local-address"])
    expect(webhookTargetWarnings("http://localhost:9000/hooks/print-trail")).toEqual(["not-https", "local-address"])
    expect(webhookTargetWarnings("https://192.168.1.4")).toEqual(["local-address"])
    expect(webhookTargetWarnings("https://[::1]")).toEqual(["local-address"])
    expect(webhookTargetWarnings("https://medusa")).toEqual(["local-address"])
    for (const host of ["10.0.0.1", "100.64.1.1", "127.0.0.1", "169.254.1.1", "172.16.0.1", "172.31.255.255", "0.0.0.0", "[fd00::1]", "[fe80::1]", "shop.local", "a.localhost", "db.internal"]) {
      expect(webhookTargetWarnings(`https://${host}`)).toEqual(["local-address"])
    }
    for (const host of ["[::ffff:127.0.0.1]", "[::ffff:10.1.2.3]", "[::ffff:7f00:1]", "[::ffff:c0a8:104]", "localhost.", "a.localhost.", "medusa."]) {
      expect(webhookTargetWarnings(`https://${host}`)).toEqual(["local-address"])
    }
    expect(webhookTargetWarnings("https://[::ffff:8.8.8.8]")).toEqual([])
    expect(webhookTargetWarnings("https://shop.example.com.")).toEqual([])
    expect(webhookTargetWarnings("https://172.32.0.1")).toEqual([])
    expect(webhookTargetWarnings("https://shop.example.com")).toEqual([])
    expect(webhookTargetWarnings(null)).toEqual([])
  })

  it("applies API 1.2.0's webhook URL rules: reserved, multicast and documentation addresses too", () => {
    for (const host of ["224.0.0.1", "239.1.2.3", "240.0.0.1", "255.255.255.255", "192.0.2.10", "198.51.100.1", "203.0.113.9", "198.18.0.1", "192.0.0.8", "[ff02::1]", "[::]", "[2001:db8::1]"]) {
      expect(webhookTargetWarnings(`https://${host}`)).toEqual(["local-address"])
    }
    // URL parsing turns numeric hosts into the address they stand for.
    expect(webhookTargetWarnings("https://127.1/hooks")).toEqual(["local-address"])
    expect(webhookTargetWarnings("https://0x7f000001/hooks")).toEqual(["local-address"])
    expect(webhookTargetWarnings("https://8.8.8.8/hooks")).toEqual([])
    expect(webhookTargetWarnings("https://[2606:4700::1111]/hooks")).toEqual([])
  })

  it("flags what Print Trail never accepts: over 200 characters, credentials, a fragment", () => {
    const base = "https://shop.example.com/"
    expect(webhookTargetWarnings(base + "a".repeat(200 - base.length))).toEqual([])
    expect(webhookTargetWarnings(base + "a".repeat(201 - base.length))).toEqual(["too-long"])
    // Characters, not UTF-16 units: 200 characters with non-ASCII in the path.
    expect(webhookTargetWarnings(base + "📚".repeat(200 - base.length))).toEqual([])
    expect(webhookTargetWarnings("https://user:pw@shop.example.com/hooks")).toEqual(["credentials"])
    expect(webhookTargetWarnings("https://shop.example.com/hooks#x")).toEqual(["fragment"])
  })

  it("registers only a fetched channel's missing or foreign URL, and asks first for an unsafe one", () => {
    expect(decideRegistration("registered", [], false)).toBe("already-registered")
    expect(decideRegistration("registered", ["not-https"], true)).toBe("already-registered")
    expect(decideRegistration("unknown", [], true)).toBe("cannot-register")
    expect(decideRegistration("no-backend-url", [], true)).toBe("cannot-register")
    expect(decideRegistration("not-registered", [], false)).toBe("register")
    // Never take over another address without asking.
    expect(decideRegistration("elsewhere", [], false)).toBe("needs-confirmation")
    expect(decideRegistration("elsewhere", [], true)).toBe("register")
    expect(decideRegistration("not-registered", ["local-address"], false)).toBe("needs-confirmation")
    expect(decideRegistration("elsewhere", ["not-https"], false)).toBe("needs-confirmation")
    expect(decideRegistration("elsewhere", ["not-https"], true)).toBe("register")
  })

  it("flags a URL registered before API 1.2.0 that Print Trail no longer delivers to", () => {
    expect(withDeliveryWarning("registered", ["not-https"])).toEqual(["not-https", "undeliverable"])
    expect(withDeliveryWarning("registered", ["local-address"])).toEqual(["local-address", "undeliverable"])
    expect(withDeliveryWarning("registered", [])).toEqual([])
    expect(withDeliveryWarning("not-registered", ["not-https"])).toEqual(["not-https"])
  })

  it("never registers what Print Trail never accepts, whatever the answer", () => {
    for (const w of ["too-long", "credentials", "fragment"] as const) {
      expect(decideRegistration("not-registered", [w], false)).toBe("invalid-url")
      expect(decideRegistration("not-registered", ["not-https", w], true)).toBe("invalid-url")
      expect(decideRegistration("elsewhere", [w], true)).toBe("invalid-url")
    }
  })

  it("warns when locking is in memory or Postgres", () => {
    expect(lockingWarnings({ provider: "in-memory", postgresConfigured: false, supported: true })).toEqual(["in-memory-locking"])
    expect(lockingWarnings({ provider: "redis", postgresConfigured: false, supported: true })).toEqual([])
    expect(lockingWarnings({ provider: "postgres", postgresConfigured: true, supported: false })).toEqual(["postgres-locking"])
    expect(lockingWarnings({ provider: "redis", postgresConfigured: true, supported: true })).toEqual(["postgres-locking-configured"])
    expect(lockingWarnings({ provider: "other", postgresConfigured: false, supported: true })).toEqual([])
    expect(lockingWarnings(null)).toEqual([])
  })

  it("lists the settings warnings", () => {
    const locking: LockingCheck = { provider: "redis", postgresConfigured: false, supported: true }
    expect(settingsWarnings(resolvePluginOptions({}), { locking, ptShippingOptionCount: 0 })).toEqual([
      "not-configured",
      "no-webhook-secret",
      "no-backend-url",
      "no-admin-url",
      "no-admin-email",
      "no-print-trail-shipping-options",
    ])
    const full = resolvePluginOptions({
      baseUrl: "https://pt.example",
      channelId: "c",
      apiToken: "t",
      webhookSecret: "s",
      backendUrl: "https://shop.example",
      adminUrl: "https://shop.example/app",
      notifications: { adminEmail: "ops@example.com" },
    })
    expect(settingsWarnings(full, { locking, ptShippingOptionCount: 1 })).toEqual([])
    // The stored secret counts, and a configured one that differs is flagged.
    const noConfigured = resolvePluginOptions({ ...full, webhookSecret: undefined })
    expect(settingsWarnings(noConfigured, { locking, ptShippingOptionCount: 1, secret: { source: "print-trail", mismatch: false } })).toEqual([])
    expect(settingsWarnings(noConfigured, { locking, ptShippingOptionCount: 1, secret: { source: null, mismatch: false } })).toEqual([
      "no-webhook-secret",
    ])
    expect(settingsWarnings(full, { locking, ptShippingOptionCount: 1, secret: { source: "print-trail", mismatch: true } })).toEqual([
      "webhook-secret-mismatch",
    ])
    const noEmailNeeded = resolvePluginOptions({ ...full, notifications: { cancelTooLate: false } })
    expect(settingsWarnings(noEmailNeeded, { locking: { ...locking, provider: "in-memory" }, ptShippingOptionCount: 1 })).toEqual([
      "in-memory-locking",
    ])
  })

  it("builds the health view", () => {
    expect(healthView(null, [])).toEqual({ reconnect: false, channelInactive: false, unmatchedSkus: 0 })
    expect(healthView({ at: "x", path: "/token" }, ["A", "B"])).toEqual({ reconnect: true, channelInactive: false, unmatchedSkus: 2 })
    expect(healthView(null, null, { at: "x", path: "/orders" })).toEqual({ reconnect: false, channelInactive: true, unmatchedSkus: 0 })
  })

  it("printTrailAppPath builds team pages", () => {
    const o = { baseUrl: "https://api.printtrail.com" }
    expect(printTrailAppPath(o, "acme", "settings/channels")).toBe("https://app.printtrail.com/acme/settings/channels")
    expect(printTrailAppPath(o, null, "settings/channels")).toBeNull()
    expect(printTrailAppPath({}, "acme", "settings/team")).toBeNull()
  })
})
