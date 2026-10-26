// Arguments, environment and the safety rules. Pure: nothing here makes a
// request, so the unit tests cover every refusal.
import { assertStagingTarget } from "../../../integration-tests/staging/guard"
import { RETRY_DELAY_MS } from "../../../src/lib/retry"
import { assertStoreUrl, parseForbiddenStores, StoreGuardError, type ForbiddenStore } from "./store-guard"

export type Mode = "staging" | "mock"

export type Args = {
  mock: boolean
  nonInteractive: boolean
  list: boolean
  help: boolean
  only: string[]
  skip: string[]
  envFile: string | null
  // Opt-in scenarios to run as well (they change staging data for good).
  include: string[]
  // Clean up an earlier run by its id, then stop.
  cleanup: string | null
}

export type Config = {
  mode: Mode
  interactive: boolean
  storeUrl: string
  // CHECKLIST_FORBIDDEN_STORE_URLS: stores the checklist must never reach.
  forbiddenStores: ForbiddenStore[]
  admin: { email: string; password: string }
  publishableKey: string
  printTrail: { baseUrl: string; channelId: string; apiToken: string }
  // The secret the mock signs webhooks with (mock mode only).
  mockWebhookSecret: string
  skus: {
    stocked: string
    second: string | null
    preOrderUnlimited: string | null
    preOrderLimited: string | null
  }
  regionId: string | null
  countryCode: string
  // `{run}` is replaced with the run id.
  customerEmail: string
  adminInboxNote: string | null
  // CHECKLIST_STAGING_DISPATCH: someone can dispatch with tracking on this
  // Print Trail (a warehouse). Off, staging skips the scenarios that need it.
  stagingDispatch: boolean
  timeouts: { send: number; webhook: number; human: number; crash: number }
  runId: string
}

export class ConfigError extends Error {}

const RUN_ID = /^[a-z0-9-]{1,32}$/i

const refuse = (why: string): never => {
  throw new ConfigError(why)
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { mock: false, nonInteractive: false, list: false, help: false, only: [], skip: [], envFile: null, include: [], cleanup: null }
  const list = (v: string | undefined) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2)
    const value = () => {
      const v = inline ?? argv[++i]
      if (v === undefined || v === "" || v.startsWith("--")) refuse(`${flag} needs a value`)
      return v
    }
    switch (flag) {
      case "--mock":
        args.mock = true
        break
      case "--non-interactive":
        args.nonInteractive = true
        break
      case "--list":
        args.list = true
        break
      case "--help":
      case "-h":
        args.help = true
        break
      case "--only":
        args.only.push(...list(value()))
        break
      case "--skip":
        args.skip.push(...list(value()))
        break
      case "--env-file":
        args.envFile = value()
        break
      case "--include":
        args.include.push(...list(value()))
        break
      case "--cleanup":
        args.cleanup = value()
        if (!RUN_ID.test(args.cleanup)) refuse("--cleanup takes a run id: letters, digits and dashes")
        break
      default:
        refuse(`unknown argument ${JSON.stringify(argv[i])} (try --help)`)
    }
  }
  return args
}

export { assertStoreUrl } from "./store-guard"

// Mock mode reaches only the bundled mock on this machine.
export function assertMockTarget(raw: string | undefined): URL {
  if (!raw) return refuse("PT_STAGING_BASE_URL is not set (in --mock mode, the mock's address, e.g. http://127.0.0.1:4011)")
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return refuse("PT_STAGING_BASE_URL is not a URL")
  }
  if (url.username || url.password) refuse("PT_STAGING_BASE_URL must not carry a user name or password")
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname.replace(/\/+$/, "") !== "") {
    refuse("--mock allows only http://127.0.0.1:<port>")
  }
  return url
}

export function assertPrintTrailTarget(mode: Mode, raw: string | undefined): URL {
  if (mode === "mock") return assertMockTarget(raw)
  try {
    const parsed = raw ? new URL(raw) : null
    if (parsed && (parsed.username || parsed.password)) refuse("PT_STAGING_BASE_URL must not carry a user name or password")
  } catch (e) {
    if (e instanceof ConfigError) throw e
  }
  try {
    return assertStagingTarget(raw)
  } catch (e) {
    // The guard quotes the value; name the variable instead.
    const message = (e as Error).message.replace(/^staging smoke: /, "").replace(JSON.stringify(raw ?? null), "PT_STAGING_BASE_URL")
    return refuse(message)
  }
}

const seconds = (env: NodeJS.ProcessEnv, key: string, fallback: number) => {
  const raw = env[key]
  if (!raw) return fallback * 1000
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) refuse(`${key} must be a number of seconds`)
  return n * 1000
}

// A switch: 1 or true is on; unset, empty, 0 or false is off.
const switchOn = (env: NodeJS.ProcessEnv, key: string) => {
  const raw = env[key]?.trim().toLowerCase()
  if (!raw || raw === "0" || raw === "false") return false
  if (raw === "1" || raw === "true") return true
  return refuse(`${key} must be 1 or true (on), or 0 or false (off)`)
}

// A send cut off by a restart is retried once its lease (the plugin's retry
// delay) has passed, by the next sweep: one default sweep interval (5 min)
// and a margin after that.
export const CRASH_TIMEOUT_SECONDS = RETRY_DELAY_MS / 1000 + 600

export function loadConfig(args: Args, env: NodeJS.ProcessEnv, now = new Date()): Config {
  const mode: Mode = args.mock ? "mock" : "staging"
  const printTrailUrl = assertPrintTrailTarget(mode, env.PT_STAGING_BASE_URL)
  let storeUrl: URL
  let forbiddenStores: ForbiddenStore[]
  try {
    forbiddenStores = parseForbiddenStores(env.CHECKLIST_FORBIDDEN_STORE_URLS)
    storeUrl = assertStoreUrl(env.STORE_URL, forbiddenStores)
  } catch (e) {
    if (e instanceof StoreGuardError) refuse(e.message)
    throw e
  }
  if (storeUrl.origin === printTrailUrl.origin) refuse("STORE_URL and PT_STAGING_BASE_URL are the same address")

  const required = (key: string, fallback?: string) => env[key]?.trim() || fallback || refuse(`${key} is not set`)
  const optional = (key: string) => env[key]?.trim() || null
  const mockDefault = (value: string) => (mode === "mock" ? value : undefined)

  const runId = optional("CHECKLIST_RUN_ID") ?? `ck${now.toISOString().replace(/\D/g, "").slice(2, 14)}`
  if (!RUN_ID.test(runId)) refuse("CHECKLIST_RUN_ID may only hold letters, digits and dashes")

  const customerEmail = optional("CHECKLIST_CUSTOMER_EMAIL") ?? "checklist+{run}@example.com"
  if (!customerEmail.includes("@")) refuse("CHECKLIST_CUSTOMER_EMAIL must be an email address")

  return {
    mode,
    interactive: !args.nonInteractive,
    storeUrl: storeUrl.origin,
    forbiddenStores,
    admin: { email: required("STORE_ADMIN_EMAIL"), password: required("STORE_ADMIN_PASSWORD") },
    publishableKey: required("STORE_PUBLISHABLE_KEY"),
    printTrail: {
      baseUrl: printTrailUrl.origin,
      channelId: required("PT_STAGING_CHANNEL_ID", mockDefault("test-channel")),
      apiToken: required("PT_STAGING_API_TOKEN", mockDefault("dev-token")),
    },
    mockWebhookSecret: optional("CHECKLIST_MOCK_WEBHOOK_SECRET") ?? "mock-secret",
    skus: {
      stocked: required("PT_STOCKED_SKU", mockDefault("9780000000002")),
      second: optional("PT_SECOND_SKU"),
      preOrderUnlimited: optional("PT_PREORDER_SKU"),
      preOrderLimited: optional("PT_PREORDER_LIMITED_SKU"),
    },
    regionId: optional("CHECKLIST_REGION_ID"),
    countryCode: (optional("CHECKLIST_COUNTRY") ?? "gb").toLowerCase(),
    customerEmail: customerEmail.replace("{run}", runId),
    adminInboxNote: optional("CHECKLIST_ADMIN_INBOX"),
    stagingDispatch: switchOn(env, "CHECKLIST_STAGING_DISPATCH"),
    timeouts: {
      send: seconds(env, "CHECKLIST_SEND_TIMEOUT", 90),
      webhook: seconds(env, "CHECKLIST_WEBHOOK_TIMEOUT", mode === "mock" ? 30 : 180),
      human: seconds(env, "CHECKLIST_HUMAN_TIMEOUT", 900),
      crash: seconds(env, "CHECKLIST_CRASH_TIMEOUT", CRASH_TIMEOUT_SECONDS),
    },
    runId,
  }
}

// Every value in the config that must never be printed.
export function secretsOf(config: Config): string[] {
  return [config.admin.password, config.printTrail.apiToken, config.publishableKey, config.mockWebhookSecret, config.customerEmail].filter(
    (s) => !!s
  )
}

// Replaces any secret (and anything that looks like a bearer token) in text.
// Longest first, so a secret that contains another is removed whole.
// Patterns first (a literal secret replaced first could break up a token the
// patterns would have caught), then the literal secrets, longest first.
export function redact(text: string, secrets: string[]): string {
  let out = text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/(\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1[redacted]@")
  for (const s of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(s).join("[redacted]")
  return out
}

// Redacts every string in a value (before it is serialised, so escaping
// can't hide a secret from the match).
export function redactDeep<T>(value: T, secrets: string[]): T {
  if (typeof value === "string") return redact(value, secrets) as T
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets)) as T
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, secrets)])) as T
  }
  return value
}

// Opt-in scenarios run only when named in --include or --only.
export function selectScenarios<T extends { id: string; optIn?: boolean }>(all: T[], args: Pick<Args, "only" | "skip" | "include">): T[] {
  const known = new Set(all.map((s) => s.id))
  for (const id of [...args.only, ...args.skip, ...args.include]) {
    if (!known.has(id)) refuse(`unknown scenario ${JSON.stringify(id)} (see --list)`)
  }
  return all.filter((s) => {
    if (args.skip.includes(s.id)) return false
    if (args.only.length) return args.only.includes(s.id)
    return !s.optIn || args.include.includes(s.id)
  })
}

// Pre-order products arrived in API 1.3.0; 1.2.0 is a security release
// without them.
export const PRE_ORDER_API_VERSION = "1.3.0"

// Compares dotted versions ("1.2.0"); a missing version is lowest.
export function versionAtLeast(version: string | null | undefined, min: string): boolean {
  if (!version) return false
  const a = version.split(".").map((n) => parseInt(n, 10) || 0)
  const b = min.split(".").map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return true
}
