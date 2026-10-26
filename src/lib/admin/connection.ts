import { randomUUID } from "node:crypto"
import type { ILockingModule, MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { isConnected, type PrintTrailPluginOptions } from "../../config"
import { PRINT_TRAIL_MODULE } from "../../modules/printTrail"
import { DEFAULT_RETRY_DELAYS_MS, DEFAULT_TIMEOUT_MS, type PrintTrailClient } from "../../modules/printTrail/client/client"
import { ACCESS_REFUSED, PrintTrailApiError } from "../../modules/printTrail/client/errors"
import type { PtChannel, PtShippingMethod } from "../../modules/printTrail/client/types"
import type PrintTrailModuleService from "../../modules/printTrail/service"
import type { ConnectionTestResult, ConnectionView, Diagnosis, LockingView, RotateResult } from "../admin-types"
import { printTrailAppPath } from "../app-url"
import { readApiVersion } from "../api-version"
import { AUTH_FAILED_STATE_KEY, CHANNEL_INACTIVE_STATE_KEY, type AuthFailedState, type ChannelInactiveState } from "../auth-state"
import { PRINT_TRAIL_PROVIDER_ID } from "../lines"
import { detectLocking, LOCKING_CHECK_STATE_KEY, type LockingCheck } from "../locking-check"
import { FALLBACK_METHODS } from "../rate-card"
import { schedulesInForce } from "../schedules"
import { readUnmatchedSkus } from "../stock"
import { TEAM_CODE_STATE_KEY, type StateStore, type TeamCodeState } from "../team-code"
import { knownSecrets, readWebhookSecrets, storeWebhookSecret } from "../webhook-secret"
import {
  decideRegistration,
  diagnose,
  endpointInfo,
  healthView,
  maskSecret,
  settingsWarnings,
  webhookState,
  webhookTarget,
  webhookTargetWarnings,
  withDeliveryWarning,
} from "./connection-decisions"

type ConnectionClient = Pick<
  PrintTrailClient,
  "getToken" | "getChannel" | "listShippingMethods" | "registerWebhook" | "rotateWebhookSecret"
>

export type ConnectionDeps = {
  options: PrintTrailPluginOptions
  // null: not connected. statusClient is the no-retry, short-timeout client
  // for the read-only status; client is the normal one.
  client: ConnectionClient | null
  statusClient: ConnectionClient | null
  state: StateStore
  locking: LockingView | null
  ptShippingOptionCount: number
  env?: NodeJS.ProcessEnv
  now?: () => Date
  // Serialises fetching and storing the webhook secret across processes
  // (WEBHOOK_SECRET_LOCK), so a register racing a rotate can't store the
  // older secret last. Absent: runs unlocked (tests).
  lock?: <T>(fn: () => Promise<T>) => Promise<T>
}

export const WEBHOOK_SECRET_LOCK = "print-trail:webhook-secret"
// How long the lock is held at most (its expiry). Under the lock, two Print
// Trail calls run (the channel read, then the register or rotate), each of
// which can take every attempt's timeout plus the waits between retries;
// state writes add a little.
const CALL_BUDGET_MS =
  DEFAULT_TIMEOUT_MS * (DEFAULT_RETRY_DELAYS_MS.length + 1) + DEFAULT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)
export const WEBHOOK_SECRET_LOCK_SECONDS = Math.ceil((2 * CALL_BUDGET_MS) / 1000) + 30

// How long Test connection, Re-register, Rotate and the sweep wait for the
// lock before answering "busy": short, so the admin isn't left waiting.
export const WEBHOOK_SECRET_LOCK_WAIT_MS = 12_000

export class SecretLockBusyError extends Error {
  constructor() {
    super("Another Print Trail connection check is running")
    this.name = "SecretLockBusyError"
  }
}

// Takes the lock with the long expiry, waiting at most waitMs for it (the
// Locking Module's execute() can't wait briefly and hold long: its timeout is
// both). Throws SecretLockBusyError when it stays held.
export async function withSecretLock<T>(
  locking: Pick<ILockingModule, "acquire" | "release">,
  fn: () => Promise<T>,
  opts: { waitMs?: number; pollMs?: number } = {}
): Promise<T> {
  const ownerId = randomUUID()
  const deadline = Date.now() + (opts.waitMs ?? WEBHOOK_SECRET_LOCK_WAIT_MS)
  for (;;) {
    try {
      await locking.acquire(WEBHOOK_SECRET_LOCK, { ownerId, expire: WEBHOOK_SECRET_LOCK_SECONDS })
      break
    } catch {
      if (Date.now() >= deadline) throw new SecretLockBusyError()
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 250))
    }
  }
  try {
    return await fn()
  } finally {
    await locking.release(WEBHOOK_SECRET_LOCK, { ownerId })
  }
}

async function locked<T>(deps: ConnectionDeps, fn: () => Promise<T>, busy: T): Promise<T> {
  try {
    return await (deps.lock ? deps.lock(fn) : fn())
  } catch (e) {
    if (e instanceof SecretLockBusyError) return busy
    throw e
  }
}

type WebhookResult = ConnectionTestResult["webhook"]

const fallbackMethods = () => FALLBACK_METHODS.map((code) => ({ code, name: code }))

const nowOf = (deps: ConnectionDeps) => (deps.now ? deps.now() : new Date())

// Belt and braces: the client already redacts the token from details. Also
// removes every webhook secret the plugin knows (configured, stored, and any
// just returned).
async function scrub(deps: ConnectionDeps, text: string, extra: (string | null)[] = []): Promise<string> {
  let out = text
  const secrets = [deps.options.apiToken, ...(await knownSecrets(deps.state, deps.options)), ...extra]
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[redacted]")
  }
  return out
}

// What a failed register or rotate says: the refusal in plain words for a
// bad token or channel ID or an inactive channel, else Print Trail's detail
// (a webhook URL's 422 names the rule it broke).
async function failureDetail(deps: ConnectionDeps, e: unknown): Promise<string> {
  if (!(e instanceof PrintTrailApiError)) return "unexpected error"
  const refusal = e.accessRefusal
  return refusal ? ACCESS_REFUSED[refusal] : scrub(deps, e.detail)
}

async function runDiagnosis(deps: ConnectionDeps, client: ConnectionClient): Promise<Diagnosis> {
  let result: unknown
  try {
    result = await client.getToken()
  } catch (e) {
    result = e
  }
  const d = diagnose(deps.options.channelId ?? "", result)
  return !d.ok && d.detail ? { ...d, detail: await scrub(deps, d.detail) } : d
}

// Stores the secret Print Trail returned (an older Print Trail API returns
// none: the configured fallback stays in use). false: it couldn't be stored.
async function keepSecret(deps: ConnectionDeps, secret: string | null): Promise<boolean> {
  if (!secret) return true
  try {
    await storeWebhookSecret(deps.state, deps.options.apiToken, secret, nowOf(deps))
    return true
  } catch {
    return false
  }
}

// Shown with a register that worked when the secret wasn't stored.
export const SECRET_NOT_STORED = "secret-not-stored"

const methodsFrom = (list: PtShippingMethod[]) =>
  list.flatMap((m) => (m?.code ? [{ code: m.code, name: m.name || m.code }] : []))

// The settings page's automatic check. Read-only: it never registers a
// webhook and never writes state (the client's own auth tracking aside).
export async function connectionStatus(deps: ConnectionDeps): Promise<ConnectionView> {
  const { options } = deps
  const configured = isConnected(options) && !!deps.statusClient
  const targetUrl = webhookTarget(options.backendUrl)
  const targetWarnings = webhookTargetWarnings(targetUrl)

  let diagnosis: Diagnosis = { ok: false, code: "not-configured" }
  let channel: PtChannel | null = null
  let methods: { code: string; name: string }[] | null = null
  if (configured) {
    diagnosis = await runDiagnosis(deps, deps.statusClient!)
    if (diagnosis.ok) {
      const [ch, sm] = await Promise.allSettled([deps.statusClient!.getChannel(), deps.statusClient!.listShippingMethods()])
      channel = ch.status === "fulfilled" ? ch.value : null
      if (sm.status === "fulfilled" && Array.isArray(sm.value)) {
        const list = methodsFrom(sm.value)
        methods = list.length ? list : null
      }
    }
  }

  const teamCode = diagnosis.ok ? diagnosis.teamCode : null
  const webhook = webhookState(channel, targetUrl)
  const [authFailed, unmatched, secret, apiVersion, channelInactive] = await Promise.all([
    deps.state.getState<AuthFailedState>(AUTH_FAILED_STATE_KEY),
    readUnmatchedSkus(deps.state),
    readWebhookSecrets(deps.state, options, nowOf(deps)),
    readApiVersion(deps.state),
    deps.state.getState<ChannelInactiveState>(CHANNEL_INACTIVE_STATE_KEY),
  ])

  return {
    configured,
    endpoint: endpointInfo(options.baseUrl),
    credentials: {
      channelId: options.channelId ?? null,
      apiToken: maskSecret(options.apiToken),
      // Set or not, and where from: no characters of the secret leave the server.
      webhookSecret: { set: !!secret.source, ending: null, source: secret.source },
    },
    diagnosis,
    channel: diagnosis.ok
      ? {
          name: channel?.name ?? null,
          code: channel?.code ?? diagnosis.channelCode,
          url: printTrailAppPath(options, teamCode, "settings/channels"),
        }
      : null,
    team: diagnosis.ok
      ? {
          name: channel?.team?.name ?? null,
          code: channel?.team?.code ?? diagnosis.teamCode,
          url: printTrailAppPath(options, teamCode, "settings/team"),
        }
      : null,
    webhook: { state: webhook.state, registeredUrl: webhook.registeredUrl, targetUrl, warnings: withDeliveryWarning(webhook.state, targetWarnings) },
    shippingMethods: methods ?? fallbackMethods(),
    shippingMethodsSource: methods ? "print-trail" : "fallback",
    options: {
      orderNumberPrefix: options.orderNumberPrefix,
      defaultShippingMethod: options.defaultShippingMethod,
      confirmOn: options.confirmOn,
      strictSkus: options.strictSkus,
      stockSync: options.stockSync.enabled,
      reconcile: { ...options.reconcile },
      autoComplete: options.autoComplete,
      // A count, never the addresses.
      notifications: {
        shipment: options.notifications.shipment,
        cancelTooLate: options.notifications.cancelTooLate,
        adminEmailCount: options.notifications.adminEmail.length,
      },
      stockLocationIds: options.stockLocationIds ?? null,
      appUrl: options.appUrl ?? null,
      adminUrl: options.adminUrl ?? null,
      backendUrl: options.backendUrl ?? null,
    },
    locking: deps.locking,
    schedules: schedulesInForce(deps.env),
    warnings: settingsWarnings(options, {
      locking: deps.locking,
      ptShippingOptionCount: deps.ptShippingOptionCount,
      secret: { source: secret.source, mismatch: secret.mismatch },
    }),
    health: healthView(authFailed, unmatched, channelInactive),
    api_version: apiVersion,
  }
}

// Reads the channel and registers this store's URL when the channel has none
// or another one. Never over a URL it hasn't seen; an unsafe target only with
// force. When the channel already sends here, posts the same URL again: Print
// Trail returns the current webhook secret from that call (and never rotates
// it there), which is how a secret rotated in the Print Trail app is picked up.
function registerIfNeeded(deps: ConnectionDeps, client: ConnectionClient, force: boolean): Promise<WebhookResult> {
  return locked(deps, () => registerUnlocked(deps, client, force), {
    action: "busy",
    state: "unknown",
    warnings: webhookTargetWarnings(webhookTarget(deps.options.backendUrl)),
  })
}

async function registerUnlocked(deps: ConnectionDeps, client: ConnectionClient, force: boolean): Promise<WebhookResult> {
  const target = webhookTarget(deps.options.backendUrl)
  const warnings = webhookTargetWarnings(target)
  let channel: PtChannel | null = null
  try {
    channel = await client.getChannel()
  } catch {
    channel = null
  }
  const { state, registeredUrl } = webhookState(channel, target)
  const decision = decideRegistration(state, warnings, force)
  if (decision === "already-registered") {
    // The URL is right; say so when only the secret couldn't be fetched or
    // stored this time.
    let kept = false
    try {
      kept = await keepSecret(deps, (await client.registerWebhook(target!)).secret)
    } catch {
      kept = false
    }
    return { action: decision, state, warnings: withDeliveryWarning(state, warnings), ...(kept ? {} : { detail: SECRET_NOT_STORED }) }
  }
  if (decision !== "register") {
    return { action: decision, state, warnings, ...(state === "elsewhere" && registeredUrl ? { registeredUrl } : {}) }
  }
  try {
    const { channel: updated, secret } = await client.registerWebhook(target!)
    const kept = await keepSecret(deps, secret)
    const after = updated ? webhookState(updated, target).state : "registered"
    return { action: "registered", state: after === "unknown" ? "registered" : after, warnings, ...(kept ? {} : { detail: SECRET_NOT_STORED }) }
  } catch (e) {
    return { action: "failed", state, warnings, detail: await failureDetail(deps, e) }
  }
}

const notConnected = (): ConnectionTestResult => ({
  diagnosis: { ok: false, code: "not-configured" },
  webhook: { action: "cannot-register", state: "unknown", warnings: [] },
})

// "Test connection": diagnose, store the team code, then register the
// webhook.
export async function testConnection(deps: ConnectionDeps): Promise<ConnectionTestResult> {
  if (!isConnected(deps.options) || !deps.client) return notConnected()
  // Diagnose with the short-timeout client (a hung Print Trail answers in
  // seconds); register with the normal one.
  const diagnosis = await runDiagnosis(deps, deps.statusClient ?? deps.client)
  const warnings = webhookTargetWarnings(webhookTarget(deps.options.backendUrl))
  if (!diagnosis.ok) {
    return { diagnosis, webhook: { action: "cannot-register", state: "unknown", warnings } }
  }
  const team: TeamCodeState = {
    teamCode: diagnosis.teamCode,
    channelCode: diagnosis.channelCode,
    channelId: diagnosis.channelId,
    fetchedAt: nowOf(deps).toISOString(),
  }
  await deps.state.setState(TEAM_CODE_STATE_KEY, team)
  // A 401 or an inactive channel recorded by another process (a worker)
  // isn't known to this process's tracker: a working token clears it here.
  for (const key of [AUTH_FAILED_STATE_KEY, CHANNEL_INACTIVE_STATE_KEY]) {
    if (await deps.state.getState<AuthFailedState>(key)) {
      await deps.state.setState(key, null)
    }
  }
  return { diagnosis, webhook: await registerIfNeeded(deps, deps.client, false) }
}

// "Re-register", and the yes to the unsafe-URL prompt.
export async function registerWebhook(deps: ConnectionDeps, input: { force: boolean }): Promise<WebhookResult> {
  if (!isConnected(deps.options) || !deps.client) return notConnected().webhook
  return registerIfNeeded(deps, deps.client, input.force)
}

// "Rotate webhook secret": only while the channel sends to this store. The
// new secret is stored at once and the old one is accepted for the grace
// window (deliveries already queued keep the old signature).
export function rotateSecret(deps: ConnectionDeps): Promise<RotateResult> {
  return locked(deps, () => rotateUnlocked(deps), { action: "busy" })
}

async function rotateUnlocked(deps: ConnectionDeps): Promise<RotateResult> {
  if (!isConnected(deps.options) || !deps.client) return { action: "not-registered" }
  const target = webhookTarget(deps.options.backendUrl)
  let channel: PtChannel | null = null
  try {
    channel = await deps.client.getChannel()
  } catch {
    channel = null
  }
  if (webhookState(channel, target).state !== "registered") return { action: "not-registered" }
  try {
    const { secret } = await deps.client.rotateWebhookSecret()
    if (!secret) return { action: "unsupported" }
    // Rotated at Print Trail but not stored: Test connection fetches it.
    if (!(await keepSecret(deps, secret))) return { action: "failed", detail: SECRET_NOT_STORED }
    return { action: "rotated" }
  } catch (e) {
    // A 404 is a Print Trail API without the rotate route, unless it says
    // the channel itself is unknown.
    // (Since API 1.2.0 an unknown channel is a 401 instead; a sibling
    // channel the token doesn't own is still that 404.)
    if (e instanceof PrintTrailApiError && e.status === 404 && !/channel ID .* does not exist/i.test(e.detail)) {
      return { action: "unsupported" }
    }
    return { action: "failed", detail: await failureDetail(deps, e) }
  }
}

// The sweep's self-heal: with no readable stored secret (a new API token, a
// lost row) every webhook is refused, so while the channel sends to this
// store, post the same URL again to fetch the secret, as Test connection
// does. Never registers anywhere else. Backs off 24 h after an older Print
// Trail API returned no secret or the channel sent elsewhere (a store on the
// configured secret whose channel is registered elsewhere shouldn't read the
// channel every run), and 15 min after a failure.
export const SECRET_REFRESH_STATE_KEY = "webhook_secret_refresh"
const REFRESH_RETRY_MS = 15 * 60_000
const REFRESH_UNSUPPORTED_MS = 24 * 3600_000

export type SecretRefresh =
  | "not-configured"
  | "readable"
  | "cooling-down"
  | "not-registered"
  | "stored"
  | "unsupported"
  | "failed"
  | "busy"

// The cheap checks, with no lock and no Print Trail call: a readable stored
// secret, or a backoff still running. null: a refresh is due.
export async function secretRefreshDue(
  state: StateStore,
  options: Pick<PrintTrailPluginOptions, "apiToken" | "webhookSecret">,
  now: Date
): Promise<"readable" | "cooling-down" | null> {
  if ((await readWebhookSecrets(state, options, now)).source === "print-trail") return "readable"
  const backoff = await state.getState<{ nextAt: string }>(SECRET_REFRESH_STATE_KEY)
  if (backoff?.nextAt && Date.parse(backoff.nextAt) > now.getTime()) return "cooling-down"
  return null
}

export async function refreshWebhookSecret(deps: ConnectionDeps): Promise<SecretRefresh> {
  if (!isConnected(deps.options) || !deps.client) return "not-configured"
  // Checked before the lock, so a normal sweep takes none, and again under it.
  const skip = await secretRefreshDue(deps.state, deps.options, nowOf(deps))
  if (skip) return skip
  return locked<SecretRefresh>(deps, () => refreshUnlocked(deps, deps.client!), "busy")
}

async function refreshUnlocked(deps: ConnectionDeps, client: ConnectionClient): Promise<SecretRefresh> {
  const now = nowOf(deps)
  const skip = await secretRefreshDue(deps.state, deps.options, now)
  if (skip) return skip
  const wait = async (ms: number, outcome: SecretRefresh) => {
    await deps.state.setState(SECRET_REFRESH_STATE_KEY, { nextAt: new Date(now.getTime() + ms).toISOString(), outcome })
    return outcome
  }
  const target = webhookTarget(deps.options.backendUrl)
  let channel: PtChannel | null = null
  try {
    channel = await client.getChannel()
  } catch {
    return wait(REFRESH_RETRY_MS, "failed")
  }
  if (webhookState(channel, target).state !== "registered") return wait(REFRESH_UNSUPPORTED_MS, "not-registered")
  let secret: string | null
  try {
    secret = (await client.registerWebhook(target!)).secret
  } catch {
    return wait(REFRESH_RETRY_MS, "failed")
  }
  if (!secret) return wait(REFRESH_UNSUPPORTED_MS, "unsupported")
  if (!(await keepSecret(deps, secret))) return wait(REFRESH_RETRY_MS, "failed")
  await deps.state.setState(SECRET_REFRESH_STATE_KEY, null)
  return "stored"
}

export async function buildConnectionDeps(scope: MedusaContainer): Promise<ConnectionDeps> {
  const service = scope.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const lockingModule = scope.resolve(Modules.LOCKING)
  const options = await service.getOptions()
  const connected = await service.isConnected()
  // The startup check this process made, else what the sweep stored, else
  // the config as it reads now.
  let locking: LockingCheck | null = (await service.getLockingCheck()) ?? (await service.getState<LockingCheck>(LOCKING_CHECK_STATE_KEY))
  if (!locking) {
    try {
      locking = detectLocking(scope.resolve(ContainerRegistrationKeys.CONFIG_MODULE))
    } catch {
      locking = null
    }
  }
  const { data } = await query.graph({
    entity: "shipping_option",
    fields: ["id"],
    filters: { provider_id: PRINT_TRAIL_PROVIDER_ID },
  })
  return {
    options,
    client: connected ? await service.getClient() : null,
    statusClient: connected ? await service.getStatusClient() : null,
    state: service,
    locking,
    ptShippingOptionCount: data.length,
    lock: (fn) => withSecretLock(lockingModule, fn),
  }
}
