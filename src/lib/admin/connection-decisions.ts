import { isIP } from "node:net"
import { isConnected, STAGING_HOST, type PrintTrailPluginOptions } from "../../config"
import { PrintTrailApiError } from "../../modules/printTrail/client/errors"
import type { PtChannel, PtToken } from "../../modules/printTrail/client/types"
import type {
  Diagnosis,
  EndpointView,
  HealthView,
  LockingView,
  Masked,
  SettingsWarning,
  WebhookState,
  WebhookWarning,
} from "../admin-types"
import type { AuthFailedState, ChannelInactiveState } from "../auth-state"
import { charCount } from "../input-limits"

// The settings page's decisions, free of Medusa: masking, diagnosis, the
// webhook state and whether Test connection may register.

const SHOWN_ENDING = 4
const MIN_LENGTH_FOR_ENDING = 12

export function maskSecret(value: string | null | undefined): Masked {
  if (!value) return { set: false, ending: null }
  return { set: true, ending: value.length >= MIN_LENGTH_FOR_ENDING ? value.slice(-SHOWN_ENDING) : null }
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

export function endpointInfo(baseUrl: string | undefined): EndpointView {
  if (!baseUrl) return { url: null, environment: null }
  const host = hostOf(baseUrl)
  let environment: EndpointView["environment"] = "other"
  if ((host && host === hostOf(STAGING_HOST)) || (host && /staging/i.test(host))) environment = "staging"
  else if (host === "api.printtrail.com") environment = "production"
  return { url: baseUrl, environment }
}

const isToken = (v: unknown): v is PtToken =>
  !!v && typeof v === "object" && typeof (v as PtToken).channelId === "string" && typeof (v as PtToken).teamCode === "string"

// Checked in this order: the token's channel, then 401 (since API 1.2.0 also
// an unknown channel ID), the inactive channel's 403 (API 1.2.0), a 404
// problem (an unknown channel on an older Print Trail API; a sibling channel
// since 1.2.0), a plain 404 (not Print Trail), transient, anything else
// (another 403, such as a Standard-channel token, with Print Trail's detail).
export function diagnose(configuredChannelId: string, result: PtToken | unknown): Diagnosis {
  if (isToken(result)) {
    if (result.channelId !== configuredChannelId) {
      return { ok: false, code: "token-other-channel", tokenChannelId: result.channelId }
    }
    return { ok: true, teamCode: result.teamCode, channelCode: result.channelCode, channelId: result.channelId }
  }
  if (result instanceof PrintTrailApiError) {
    if (result.status === 401) return { ok: false, code: "token-invalid" }
    if (result.isChannelInactive) return { ok: false, code: "channel-inactive" }
    if (result.status === 404) return { ok: false, code: result.isProblem ? "channel-not-found" : "not-print-trail" }
    if (result.isTransient) return { ok: false, code: "unreachable" }
    // The client has already redacted the token from detail.
    return { ok: false, code: "error", detail: result.detail }
  }
  return { ok: false, code: "error" }
}

export function webhookTarget(backendUrl: string | undefined): string | null {
  const base = backendUrl?.trim().replace(/\/+$/, "")
  return base ? `${base}/hooks/print-trail` : null
}

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" }

// Trim, lowercase the scheme and host, drop the default port, strip trailing
// slashes from the path.
export function normaliseWebhookUrl(url: string): string {
  const trimmed = url.trim()
  try {
    const u = new URL(trimmed)
    const port = u.port && u.port !== DEFAULT_PORTS[u.protocol] ? `:${u.port}` : ""
    const path = u.pathname.replace(/\/+$/, "")
    return `${u.protocol.toLowerCase()}//${u.hostname.toLowerCase()}${port}${path}${u.search}${u.hash}`
  } catch {
    return trimmed.replace(/\/+$/, "")
  }
}

export function webhookState(
  channel: Pick<PtChannel, "webhookDetail"> | null,
  target: string | null
): { state: WebhookState; registeredUrl: string | null } {
  const registeredUrl = channel?.webhookDetail?.uri || null
  if (!channel) return { state: "unknown", registeredUrl: null }
  if (!target) return { state: "no-backend-url", registeredUrl }
  if (!registeredUrl) return { state: "not-registered", registeredUrl: null }
  return {
    state: normaliseWebhookUrl(registeredUrl) === normaliseWebhookUrl(target) ? "registered" : "elsewhere",
    registeredUrl,
  }
}

// Not public, as Print Trail's webhook URL check reads it (API 1.2.0):
// private, loopback, link-local, shared (CGNAT), multicast, reserved, and the
// special-purpose blocks outside the global range (this network, IETF
// protocol assignments, documentation, benchmarking).
const ipv4InRanges = (ip: string): boolean => {
  const [a, b, c] = ip.split(".").map(Number)
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  )
}

const ipv6Local = (ip: string): boolean => {
  const v = ip.toLowerCase()
  if (v === "::1" || v === "::") return true
  const groups = v.split(":")
  const first = parseInt(groups[0] || "0", 16)
  // fc00::/7 (unique local), fe80::/10 (link local), ff00::/8 (multicast),
  // 2001:db8::/32 (documentation).
  return (
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00 ||
    (first === 0x2001 && parseInt(groups[1] || "0", 16) === 0xdb8)
  )
}

// ::ffff:a.b.c.d, which URL parsing rewrites to ::ffff:xxxx:yyyy.
const mappedIpv4 = (ip: string): string | null => {
  const m = ip.toLowerCase().match(/^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/)
  if (!m) return null
  if (m[1]) return m[1]
  const hi = parseInt(m[2], 16)
  const lo = parseInt(m[3], 16)
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".")
}

const isLocalHost = (host: string): boolean => {
  // A trailing dot is the same name (fully qualified): localhost. is local.
  const h = host.replace(/^\[|\]$/g, "").replace(/\.$/, "")
  const kind = isIP(h)
  if (kind === 4) return ipv4InRanges(h)
  if (kind === 6) {
    const v4 = mappedIpv4(h)
    return v4 ? ipv4InRanges(v4) : ipv6Local(h)
  }
  return h === "localhost" || /\.(localhost|local|internal)$/.test(h) || !h.includes(".")
}

// API 1.2.0's webhook URL rules, checked before Print Trail is
// asked: https only, a public host (not localhost, *.localhost, *.local,
// *.internal, a single label, or a non-public address literal), at most 200
// characters, no user name, password or fragment. DNS isn't checked here;
// Print Trail's 422 says so when the host doesn't resolve or resolves to a
// private address.
export const MAX_WEBHOOK_URL_LENGTH = 200

// What Print Trail never accepts, whatever its setup: no confirm can register these.
export const NEVER_ACCEPTED: ReadonlySet<WebhookWarning> = new Set(["too-long", "credentials", "fragment"])

export function webhookTargetWarnings(url: string | null): WebhookWarning[] {
  if (!url) return []
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return ["not-https"]
  }
  const warnings: WebhookWarning[] = []
  if (u.protocol !== "https:") warnings.push("not-https")
  if (isLocalHost(u.hostname.toLowerCase())) warnings.push("local-address")
  if (charCount(url) > MAX_WEBHOOK_URL_LENGTH) warnings.push("too-long")
  if (u.username || u.password) warnings.push("credentials")
  if (u.hash || url.includes("#")) warnings.push("fragment")
  return warnings
}

// A URL registered before API 1.2.0 stays registered, but Print Trail checks
// it before every delivery and silently sends nothing to a plain-http or
// local one: say so beside "registered".
export function withDeliveryWarning(state: WebhookState, warnings: WebhookWarning[]): WebhookWarning[] {
  return state === "registered" && warnings.some((w) => w === "not-https" || w === "local-address")
    ? [...warnings, "undeliverable"]
    : warnings
}

// Registers only when the channel was read (never over a URL it hasn't
// seen), and asks first when Print Trail sends elsewhere or the target is
// one Print Trail can't deliver to. A plain-http or local target stays a
// confirm rather than a refusal: a development Print Trail (set to allow
// private hosts), the bundled mock and an older Print Trail API
// accept one, and production's 422 is shown when it doesn't. A URL no Print
// Trail accepts (too long, credentials, a fragment) is refused here.
export function decideRegistration(
  state: WebhookState,
  warnings: WebhookWarning[],
  force: boolean
): "register" | "already-registered" | "needs-confirmation" | "cannot-register" | "invalid-url" {
  if (state === "registered") return "already-registered"
  if (state === "unknown" || state === "no-backend-url") return "cannot-register"
  if (warnings.some((w) => NEVER_ACCEPTED.has(w))) return "invalid-url"
  // Another address is never taken over without asking.
  if (state === "elsewhere" && !force) return "needs-confirmation"
  if (warnings.length && !force) return "needs-confirmation"
  return "register"
}

// From the module's startup locking check: in-memory is one process only, and
// the Postgres provider is unsupported.
export function lockingWarnings(check: LockingView | null): SettingsWarning[] {
  if (!check) return []
  if (check.provider === "postgres") return ["postgres-locking"]
  const out: SettingsWarning[] = []
  if (check.provider === "in-memory") out.push("in-memory-locking")
  if (check.postgresConfigured) out.push("postgres-locking-configured")
  return out
}

// ctx.secret: from readWebhookSecrets; without it, the configured secret is
// all there is.
export function settingsWarnings(
  o: PrintTrailPluginOptions,
  ctx: {
    locking: LockingView | null
    ptShippingOptionCount: number
    secret?: { source: "print-trail" | "configured" | null; mismatch: boolean }
  }
): SettingsWarning[] {
  const secret = ctx.secret ?? { source: o.webhookSecret ? "configured" : null, mismatch: false }
  const out: SettingsWarning[] = []
  if (!isConnected(o)) out.push("not-configured")
  if (!secret.source) out.push("no-webhook-secret")
  if (secret.mismatch) out.push("webhook-secret-mismatch")
  if (!o.backendUrl) out.push("no-backend-url")
  if (!o.adminUrl) out.push("no-admin-url")
  if (o.notifications.cancelTooLate !== false && !o.notifications.adminEmail.length) out.push("no-admin-email")
  out.push(...lockingWarnings(ctx.locking))
  if (ctx.ptShippingOptionCount === 0) out.push("no-print-trail-shipping-options")
  return out
}

export function healthView(
  authFailed: AuthFailedState | null,
  unmatched: string[] | null,
  channelInactive: ChannelInactiveState | null = null
): HealthView {
  return { reconnect: !!authFailed, channelInactive: !!channelInactive, unmatchedSkus: unmatched?.length ?? 0 }
}
