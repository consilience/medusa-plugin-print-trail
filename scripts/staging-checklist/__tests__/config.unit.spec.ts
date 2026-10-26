import { RETRY_DELAY_MS } from "../../../src/lib/retry"
import {
  assertMockTarget,
  assertPrintTrailTarget,
  assertStoreUrl,
  CRASH_TIMEOUT_SECONDS,
  loadConfig,
  parseArgs,
  redact,
  redactDeep,
  secretsOf,
  PRE_ORDER_API_VERSION,
  selectScenarios,
  versionAtLeast,
} from "../lib/config"
import { parseForbiddenStores } from "../lib/store-guard"

const FAKE_TOKEN = "fake-tkn"
const FAKE_PASSWORD = "fake-pw"

const env = (over: Record<string, string | undefined> = {}) => ({
  STORE_URL: "https://store.example.com",
  STORE_ADMIN_EMAIL: "admin@example.com",
  STORE_ADMIN_PASSWORD: FAKE_PASSWORD,
  STORE_PUBLISHABLE_KEY: "fake-pk",
  PT_STAGING_BASE_URL: "https://printtrail-core.consilstaging.com",
  PT_STAGING_CHANNEL_ID: "testing-medusa",
  PT_STAGING_API_TOKEN: FAKE_TOKEN,
  PT_STOCKED_SKU: "9780000000002",
  CHECKLIST_FORBIDDEN_STORE_URLS: "",
  ...over,
})

describe("staging checklist config", () => {
  it("refuses a forbidden local store however it is spelt", () => {
    const forbidden = parseForbiddenStores("http://localhost:9300")
    for (const url of ["http://localhost:9300", "http://127.0.0.1:9300/app", "http://[::1]:9300", "http://shop.localhost:9300"]) {
      expect(() => assertStoreUrl(url, forbidden)).toThrow(/CHECKLIST_FORBIDDEN_STORE_URLS/)
    }
    expect(assertStoreUrl("http://localhost:9100", forbidden).port).toBe("9100")
  })

  it("refuses production and non-staging Print Trail hosts", () => {
    expect(() => assertPrintTrailTarget("staging", "https://api.printtrail.com")).toThrow(/production/)
    expect(() => assertPrintTrailTarget("staging", "http://printtrail-core.consilstaging.com")).toThrow(/https/)
    expect(() => assertPrintTrailTarget("staging", "https://example.com")).toThrow(/consilstaging/)
    expect(() => assertPrintTrailTarget("staging", "http://127.0.0.1:4011")).toThrow()
    expect(assertPrintTrailTarget("staging", "https://printtrail-core.consilstaging.com").hostname).toBe("printtrail-core.consilstaging.com")
  })

  it("--mock allows only http://127.0.0.1:<port>", () => {
    expect(assertMockTarget("http://127.0.0.1:4011").port).toBe("4011")
    for (const url of ["http://localhost:4011", "https://127.0.0.1:4011", "http://127.0.0.1", "https://printtrail-core.consilstaging.com", "http://127.0.0.1:4011/v1"]) {
      expect(() => assertMockTarget(url)).toThrow(/127\.0\.0\.1/)
    }
  })

  it("loads a staging config and needs the credentials", () => {
    const config = loadConfig(parseArgs([]), env(), new Date("2026-10-19T12:34:56Z"))
    expect(config.mode).toBe("staging")
    expect(config.runId).toBe("ck261019123456")
    expect(config.customerEmail).toBe("checklist+ck261019123456@example.com")
    expect(config.interactive).toBe(true)
    expect(() => loadConfig(parseArgs([]), env({ PT_STAGING_API_TOKEN: undefined }))).toThrow(/PT_STAGING_API_TOKEN/)
    const forbidden = { STORE_URL: "http://localhost:9300", CHECKLIST_FORBIDDEN_STORE_URLS: "http://localhost:9300" }
    expect(() => loadConfig(parseArgs([]), env(forbidden))).toThrow(/CHECKLIST_FORBIDDEN_STORE_URLS/)
    expect(() => loadConfig(parseArgs([]), env({ CHECKLIST_FORBIDDEN_STORE_URLS: "not a url" }))).toThrow(/isn't a URL/)
    expect(loadConfig(parseArgs([]), env({ STORE_URL: "http://localhost:9300" })).forbiddenStores).toEqual([])
  })

  it("refuses to run while CHECKLIST_FORBIDDEN_STORE_URLS is unset; empty forbids none", () => {
    const unset = env({ CHECKLIST_FORBIDDEN_STORE_URLS: undefined })
    expect(() => loadConfig(parseArgs([]), unset)).toThrow(/CHECKLIST_FORBIDDEN_STORE_URLS is not set.*\.env\.checklist.*empty to forbid none/)
    expect(() => loadConfig(parseArgs(["--mock"]), { ...unset, PT_STAGING_BASE_URL: "http://127.0.0.1:4011" })).toThrow(/is not set/)
    expect(loadConfig(parseArgs([]), env({ CHECKLIST_FORBIDDEN_STORE_URLS: "" })).forbiddenStores).toEqual([])
    expect(loadConfig(parseArgs([]), env({ CHECKLIST_FORBIDDEN_STORE_URLS: " , " })).forbiddenStores).toEqual([])
  })

  it("mock mode defaults the mock's channel, token and SKU", () => {
    const config = loadConfig(
      parseArgs(["--mock", "--non-interactive"]),
      env({ PT_STAGING_BASE_URL: "http://127.0.0.1:4011", PT_STAGING_CHANNEL_ID: undefined, PT_STAGING_API_TOKEN: undefined, PT_STOCKED_SKU: undefined })
    )
    expect(config.printTrail).toEqual({ baseUrl: "http://127.0.0.1:4011", channelId: "test-channel", apiToken: "dev-token" })
    expect(config.skus.stocked).toBe("9780000000002")
    expect(config.interactive).toBe(false)
  })

  it("waits out an interrupted send's lease after the crash restart (CHECKLIST_CRASH_TIMEOUT)", () => {
    // The plugin's retry delay, then one default sweep interval and a margin.
    expect(CRASH_TIMEOUT_SECONDS).toBe(RETRY_DELAY_MS / 1000 + 600)
    expect(loadConfig(parseArgs([]), env()).timeouts.crash).toBe(RETRY_DELAY_MS + 600_000)
    // The value CONTRIBUTING.md and .env.checklist.template give.
    expect(loadConfig(parseArgs([]), env()).timeouts.crash).toBe(1_500_000)
    expect(loadConfig(parseArgs([]), env({ CHECKLIST_CRASH_TIMEOUT: "1800" })).timeouts.crash).toBe(1_800_000)
    for (const bad of ["soon", "0", "-60"]) {
      expect(() => loadConfig(parseArgs([]), env({ CHECKLIST_CRASH_TIMEOUT: bad }))).toThrow(/CHECKLIST_CRASH_TIMEOUT must be a number of seconds/)
    }
  })

  it("redacts secrets and bearer tokens", () => {
    const config = loadConfig(parseArgs([]), env())
    const text = redact(`token ${FAKE_TOKEN}, password ${FAKE_PASSWORD}, Authorization: Bearer abc.def`, secretsOf(config))
    expect(text).not.toContain(FAKE_TOKEN)
    expect(text).not.toContain(FAKE_PASSWORD)
    expect(text).not.toContain("abc.def")
  })

  it("selects scenarios and rejects unknown ids", () => {
    const all = [{ id: "a" }, { id: "b" }, { id: "c" }]
    expect(selectScenarios(all, parseArgs(["--only", "a,c"])).map((s) => s.id)).toEqual(["a", "c"])
    expect(selectScenarios(all, parseArgs(["--skip=b"])).map((s) => s.id)).toEqual(["a", "c"])
    expect(() => selectScenarios(all, parseArgs(["--only", "z"]))).toThrow(/unknown scenario/)
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown argument/)
  })

  it("compares API versions", () => {
    expect(versionAtLeast("1.2.0", "1.2.0")).toBe(true)
    expect(versionAtLeast("1.10.0", "1.2.0")).toBe(true)
    expect(versionAtLeast("1.1.9", "1.2.0")).toBe(false)
    expect(versionAtLeast(null, "1.1.0")).toBe(false)
  })

  it("expects pre-orders from API 1.3.0, not from the 1.2.0 security release", () => {
    expect(PRE_ORDER_API_VERSION).toBe("1.3.0")
    expect(versionAtLeast("1.2.0", PRE_ORDER_API_VERSION)).toBe(false)
    expect(versionAtLeast("1.3.0", PRE_ORDER_API_VERSION)).toBe(true)
  })

  it("redacts a bearer token even when a secret is part of it", () => {
    expect(redact("Authorization: Bearer abcSECRETdef", ["SECRET"])).toBe("Authorization: Bearer [redacted]")
  })

  it("validates the --cleanup run id", () => {
    expect(parseArgs(["--cleanup", "ck261019123456"]).cleanup).toBe("ck261019123456")
    expect(() => parseArgs(["--cleanup", "../etc/passwd"])).toThrow(/run id/)
  })

  it("refuses a flag with no value", () => {
    expect(() => parseArgs(["--only"])).toThrow(/--only needs a value/)
    expect(() => parseArgs(["--only", "--mock"])).toThrow(/--only needs a value/)
    expect(() => parseArgs(["--env-file="])).toThrow(/needs a value/)
  })

  it("runs opt-in scenarios only when included or named", () => {
    const all = [{ id: "a" }, { id: "release", optIn: true }]
    expect(selectScenarios(all, parseArgs([])).map((s) => s.id)).toEqual(["a"])
    expect(selectScenarios(all, parseArgs(["--include", "release"])).map((s) => s.id)).toEqual(["a", "release"])
    expect(selectScenarios(all, parseArgs(["--only", "release"])).map((s) => s.id)).toEqual(["release"])
  })

  it("refuses credentials in the Print Trail URL without echoing them", () => {
    for (const mode of ["staging", "mock"] as const) {
      const base = mode === "mock" ? "http://u:pw@127.0.0.1:4011" : "https://u:pw@printtrail-core.consilstaging.com"
      expect(() => assertPrintTrailTarget(mode, base)).toThrow(/user name or password/)
      try {
        assertPrintTrailTarget(mode, base)
      } catch (e) {
        expect((e as Error).message).not.toContain("pw")
      }
    }
    try {
      assertPrintTrailTarget("staging", "https://evil.example.com/?q=fake-tkn")
    } catch (e) {
      expect((e as Error).message).not.toContain("fake-tkn")
    }
  })

  it("redacts short secrets, JWTs and nested values before serialising", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln"
    expect(redact(`pw abc and ${jwt}`, ["abc"])).toBe("pw [redacted] and [redacted]")
    const out = redactDeep({ a: ['say "fake-tkn"'], b: { c: "fake-tkn" }, n: 1 }, ["fake-tkn"])
    expect(JSON.stringify(out)).not.toContain("fake-tkn")
    expect(out.n).toBe(1)
  })
})
