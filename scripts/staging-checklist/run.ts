// Staging end-to-end checklist: drives a real Medusa store with the plugin
// installed, against Print Trail staging (or, with --mock, the bundled mock
// started here), and reports pass/fail/skipped/manual per check.
//
//   npm run checklist:staging -- [--mock] [--non-interactive] [--only a,b] [--skip c] [--include x] [--list]
//   npm run checklist:staging -- --cleanup <run id>
//
// Configuration: .env.checklist (see .env.checklist.template and CONTRIBUTING.md's
// "Staging checklist" section). Nothing secret is ever printed.
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { MockPrintTrail } from "../../dev/mock-print-trail"
import { cleanupRun, type CleanupResult, type PtSide, type StoreSide } from "./lib/cleanup"
import {
  ConfigError,
  loadConfig,
  parseArgs,
  PRE_ORDER_API_VERSION,
  redact,
  redactDeep,
  secretsOf,
  selectScenarios,
  versionAtLeast,
  type Args,
  type Config,
} from "./lib/config"
import { Medusa } from "./lib/medusa"
import { HumanDriver, MockDriver, PrintTrailReader, startMock } from "./lib/print-trail"
import { RunState } from "./lib/run-state"
import { counts, quietOutput, Recorder, say, sleep, table, waitFor } from "./lib/runner"
import { assertStoreTarget, StoreGuardError } from "./lib/store-guard"
import { amend, cancel, cancelTooLate, crash, refund, resend } from "./scenarios/changes"
import { EndScenario, StopRun, T, type Ctx, type Scenario, type SkuRole } from "./scenarios/common"
import { dispatch, send, twoParcel, webhook } from "./scenarios/orders"
import { preOrderLimited, preOrderMixed, preOrderRelease, preOrderUnlimited } from "./scenarios/pre-order"
import { apiVersion, connection, stock, unmatchedSku } from "./scenarios/setup"

const ROOT = resolve(__dirname, "../..")
const REPORT_DIR = join(__dirname, "reports")

type Undo = Ctx["undo"][number]

export const SCENARIOS: Scenario[] = [
  connection,
  apiVersion,
  stock,
  unmatchedSku,
  send,
  webhook,
  dispatch,
  twoParcel,
  cancel,
  cancelTooLate,
  amend,
  refund,
  resend,
  crash,
  preOrderUnlimited,
  preOrderLimited,
  preOrderMixed,
  preOrderRelease,
]

const HELP = `Usage: npm run checklist:staging -- [options]

  --mock              run against the bundled mock (started here, on PT_STAGING_BASE_URL,
                      which must be http://127.0.0.1:<port>); no person needed
  --non-interactive   record steps that need a person as "manual" instead of prompting
                      (those scenarios place no orders)
  --only a,b          run only these scenarios (see --list)
  --skip a,b          leave these out
  --include a,b       also run opt-in scenarios (preorder-release changes staging for good)
  --list              list the scenarios
  --env-file <path>   read this instead of .env.checklist
  --cleanup <run id>  cancel what an earlier run placed (its state file), then stop
`

const out = (s: string) => say(`${s}\n`)

function loadEnvFile(args: Args) {
  const file = args.envFile ? resolve(process.env.INIT_CWD ?? process.cwd(), args.envFile) : resolve(ROOT, ".env.checklist")
  if (existsSync(file)) {
    process.loadEnvFile(file)
    return file
  }
  if (args.envFile) throw new ConfigError(`no such env file: ${args.envFile}`)
  return null
}

const forbiddenList = (config: Config) => config.forbiddenStores.map((s) => s.url).join(", ") || "none"

async function guardStore(config: Config) {
  try {
    await assertStoreTarget(config.storeUrl, config.forbiddenStores)
  } catch (e) {
    if (e instanceof StoreGuardError) throw new ConfigError(e.message)
    throw e
  }
}

// Before any order: the store answers, points at this Print Trail (never a
// production one), and has a Print Trail shipping option and the variants.
async function prepare(
  config: Config,
  medusa: Medusa,
  pt: PrintTrailReader,
  mock: MockPrintTrail | null,
  undo: Undo[]
): Promise<Pick<Ctx, "config" | "medusa" | "pt" | "regionId" | "shippingOptionIds" | "variants" | "connection" | "preOrder">> {
  if (!(await medusa.health())) throw new ConfigError(`the store at ${config.storeUrl} doesn't answer /health`)
  await medusa.login()
  let view = await medusa.connection()
  if (!view.configured) throw new ConfigError("the plugin isn't configured on this store")
  if (view.endpoint?.environment === "production") throw new ConfigError("the store's plugin points at Print Trail production: refusing")
  const storePt = view.endpoint?.url ? new URL(view.endpoint.url).origin : null
  if (storePt !== config.printTrail.baseUrl) {
    throw new ConfigError(`the store's plugin talks to ${storePt ?? "nothing"}, not PT_STAGING_BASE_URL (${config.printTrail.baseUrl})`)
  }
  if (view.credentials?.channelId !== config.printTrail.channelId) {
    throw new ConfigError("the store's plugin uses another Print Trail channel than PT_STAGING_CHANNEL_ID")
  }
  const token = await pt.client.getToken()
  if (token.channelId !== config.printTrail.channelId) throw new ConfigError("PT_STAGING_API_TOKEN belongs to another channel")
  if (mock) {
    // The mock posts webhooks wherever the store registers: make sure that is
    // the store under test (a copied .env could name another), then register,
    // forced, since a local store's URL needs the admin's confirmation.
    const target = view.webhook?.targetUrl ? new URL(view.webhook.targetUrl) : null
    if (!target || target.origin !== config.storeUrl) {
      throw new ConfigError(`the store's webhook target (${target?.origin ?? "none"}) isn't STORE_URL: check MEDUSA_BACKEND_URL`)
    }
    await guardStore({ ...config, storeUrl: target.origin })
    const tested = await medusa.testConnection()
    if (tested.webhook?.action === "needs-confirmation") await medusa.registerWebhook(true)
    view = await medusa.connection()
  }

  const options = await medusa.printTrailOptions()
  if (!options.length) throw new ConfigError("the store has no shipping option on the Print Trail provider")
  const regionId = await medusa.regionFor(config.countryCode, config.regionId)

  const variants = {} as Ctx["variants"]
  const roles: [SkuRole, string | null][] = [
    ["stocked", config.skus.stocked],
    ["second", config.skus.second],
    ["preOrderUnlimited", config.skus.preOrderUnlimited],
    ["preOrderLimited", config.skus.preOrderLimited],
  ]
  for (const [role, sku] of roles) {
    const v = sku ? await medusa.findVariant(sku) : null
    variants[role] = v ? { id: v.id, productId: v.productId, sku: sku! } : null
    if (sku && !v) {
      if (role === "stocked") throw new ConfigError(`no variant in a Print Trail shipping profile resolves to PT_STOCKED_SKU (${sku})`)
      out(`  note: no variant in a Print Trail shipping profile resolves to ${sku} (${role})`)
    }
  }

  if (mock) await refreshAgainstMock(medusa, mock, variants, undo)

  // Pre-order support shows in pre-order-only fields, not just a status.
  const rows = (await pt.client.stockLevels()) as Record<string, unknown>[]
  const fields = rows.some((r) => "preOrderLimit" in r || "preOrderRemaining" in r)
  const supported = versionAtLeast(pt.apiVersion, PRE_ORDER_API_VERSION) || fields
  const why = supported
    ? ""
    : `pre-orders need Print Trail API ${PRE_ORDER_API_VERSION} (reported: ${pt.apiVersion ?? "none"}) or preOrderLimit on stock levels`
  return {
    config,
    medusa,
    pt,
    regionId,
    shippingOptionIds: new Set(options.map((o) => o.id)),
    variants,
    connection: view,
    preOrder: { supported, why },
  }
}

async function refreshAgainstMock(medusa: Medusa, mock: MockPrintTrail, variants: Ctx["variants"], undo: Undo[]) {
  // Wait for this sync to finish, so a later stock webhook isn't deferred
  // behind its lock (and carries a later changedAt).
  const sent = new Date()
  await mock.sendWebhook("stock-level-updated")
  await waitFor(
    "the stock sync to finish",
    async () => {
      const at = (await medusa.skuHealth()).lastRun?.completedAt
      return !!at && new Date(at) >= new Date(sent.getTime() - 1000)
    },
    { timeoutMs: 60_000, intervalMs: 500 }
  )
  await sleep(1100)
  const checkedAs = (id: string, sku: string) =>
    waitFor(
      `the SKU check of ${sku}`,
      async () => {
        const view = await medusa.variantView(id)
        return view.check_current && view.check?.sku?.toLowerCase() === sku.toLowerCase()
      },
      { timeoutMs: 60_000 }
    )
  for (const v of Object.values(variants)) {
    if (!v) continue
    const view = await medusa.variantView(v.id)
    if (view.check_current && view.check?.status === "matched") continue
    const metadata = await medusa.variantMetadata(v.productId, v.id)
    const flip = "CHECKLIST-REFRESH"
    // Registered before the flip, so the variant is put back whatever happens.
    let restored = false
    undo.push({
      what: `restore the metadata of variant ${v.id}`,
      run: async () => {
        if (restored) return
        await medusa.restoreVariantMetadata(v.productId, v.id, metadata)
        restored = true
      },
    })
    await medusa.setVariantMetadata(v.productId, v.id, { ...metadata, print_trail_sku: flip })
    await checkedAs(v.id, flip)
    await medusa.restoreVariantMetadata(v.productId, v.id, metadata)
    restored = true
    await checkedAs(v.id, view.resolved_sku ?? v.sku)
  }
}

const storeSide = (medusa: Medusa): StoreSide => ({
  order: (id) => medusa.order(id),
  cancelOrder: (id) => medusa.cancelOrder(id),
  ptView: (id) => medusa.ptView(id),
  findRunOrders: (runId, since) => medusa.findRunOrders(runId, since),
})

const ptSide = (pt: PrintTrailReader, mock: MockPrintTrail | null = null): PtSide => ({
  order: (uuid) => pt.order(uuid),
  cancel: (uuid) => pt.client.cancelOrder(uuid),
  ...(mock ? { settle: async (uuid: string) => mock.settleCancel(uuid, "cancelled") } : {}),
})

async function runUndo(undo: Undo[], notes: string[]): Promise<number> {
  let failed = 0
  for (const u of [...undo].reverse()) {
    try {
      await u.run()
    } catch (e) {
      failed++
      notes.push(`could not ${u.what}: ${(e as Error).message}`)
    }
  }
  return failed
}

// --cleanup <run id>: cancel what an earlier run recorded. With the store
// down, Print Trail orders are cancelled directly.
async function cleanupOnly(args: Args) {
  loadEnvFile(args)
  const state = RunState.load(REPORT_DIR, args.cleanup!)
  const config = loadConfig({ ...args, mock: state.data.mode === "mock" }, process.env)
  if (config.storeUrl !== state.data.store || config.printTrail.baseUrl !== state.data.printTrail) {
    throw new ConfigError("the configured store or Print Trail differs from the run's: refusing")
  }
  await guardStore(config)
  out(`Cleaning up run ${args.cleanup}; forbidden stores: ${forbiddenList(config)}`)
  const secrets = secretsOf(config)
  const medusa = new Medusa(config)
  const up = (await medusa.health()) && (await medusa.login().then(() => true, () => false))
  if (medusa.adminToken) secrets.push(medusa.adminToken)
  // The mock's orders went with the mock; only the store side is left.
  const pt = state.data.mode === "mock" ? null : ptSide(new PrintTrailReader(config))
  const result = await cleanupRun(state, up ? storeSide(medusa) : null, pt)
  printCleanup(result, (s) => redact(s, secrets))
  process.exit(result.failed ? 1 : 0)
}

function printCleanup(r: CleanupResult, clean: (s: string) => string) {
  out(`  ${r.orders} order(s), ${r.settled} cancelled or settled, ${r.leftShipped} dispatched (left as is), ${r.failed} failed`)
  for (const n of r.notes) out(`  - ${clean(n)}`)
}

async function main() {
  quietOutput()
  const args = parseArgs(process.argv.slice(2))
  if (args.help) return void out(HELP)
  if (args.list) {
    for (const s of SCENARIOS) out(`${s.id.padEnd(20)} ${s.title}`)
    return
  }
  if (args.cleanup) return cleanupOnly(args)
  const envFile = loadEnvFile(args)
  const config = loadConfig(args, process.env)
  await guardStore(config)
  const scenarios = selectScenarios(SCENARIOS, args)
  const secrets = secretsOf(config)
  const clean = (s: string) => redact(s, secrets)
  const recorder = new Recorder(clean)
  const startedAt = new Date()
  const state = RunState.create(REPORT_DIR, {
    runId: config.runId,
    mode: config.mode,
    store: config.storeUrl,
    printTrail: config.printTrail.baseUrl,
    startedAt: startedAt.toISOString(),
  })

  out(`Print Trail staging checklist, run ${config.runId} (${config.mode}${config.interactive ? "" : ", non-interactive"})`)
  out(`  store ${config.storeUrl}, Print Trail ${config.printTrail.baseUrl}${envFile ? `, config ${envFile}` : ""}`)
  out(`  forbidden stores: ${forbiddenList(config)}`)

  const medusa = new Medusa(config)
  const pt = new PrintTrailReader(config)
  const undo: Undo[] = []
  let mock: MockPrintTrail | null = null
  let ctx: Ctx | null = null
  let cleaned: CleanupResult | null = null
  let finishing = false

  const finish = async (code: number, fatal?: string) => {
    if (finishing) return
    finishing = true
    if (ctx) ctx.aborted = code >= 128
    if (medusa.adminToken) secrets.push(medusa.adminToken)
    const results = recorder.results
    if (fatal) results.push({ scenario: "run", check: "stopped", status: "fail", detail: clean(fatal), ms: 0 })
    out("\nCleaning up...")
    // An order mid-placement is recorded once it lands (bounded wait); the
    // cleanup also searches the run's marker twice.
    if (ctx?.inflight.size) {
      await Promise.race([Promise.allSettled([...ctx.inflight]), sleep(60_000)])
    }
    const notes: string[] = []
    const undoFailed = await runUndo(undo, notes)
    try {
      // The store side only once logged in; Print Trail directly either way.
      cleaned = await cleanupRun(state, medusa.adminToken ? storeSide(medusa) : null, ptSide(pt, mock))
    } catch (e) {
      cleaned = { orders: state.orderIds.length, settled: 0, leftShipped: 0, failed: state.orderIds.length || 1, notes: [String(e)] }
    }
    cleaned.notes.unshift(...notes)
    cleaned.failed += undoFailed
    printCleanup(cleaned, clean)
    if (cleaned.failed) {
      results.push({ scenario: "cleanup", check: "everything placed is cancelled or settled", status: "fail", detail: clean(cleaned.notes.join("; ")), ms: 0 })
    }
    await mock?.close()
    const c = counts(results)
    out(`\n${table(results)}\n`)
    out(`${c.pass} passed, ${c.fail} failed, ${c.skipped} skipped, ${c.manual} manual`)
    mkdirSync(REPORT_DIR, { recursive: true })
    const file = join(REPORT_DIR, `${config.runId}-${config.mode}.json`)
    const report = redactDeep(
      {
        runId: config.runId,
        mode: config.mode,
        interactive: config.interactive,
        store: config.storeUrl,
        printTrail: config.printTrail.baseUrl,
        apiVersion: pt.apiVersion,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        counts: c,
        results,
        orders: state.data.orders,
        cleanup: cleaned,
      },
      secrets
    )
    writeFileSync(file, JSON.stringify(report, null, 2))
    out(`Report: ${file}`)
    process.exit(code || (c.fail > 0 ? 1 : 0))
  }

  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    process.on(signal, () => {
      if (finishing) process.exit(code)
      out(`\nInterrupted (${signal}).`)
      void finish(code)
    })
  }

  try {
    mock = config.mode === "mock" ? await startMock(config) : null
    const base = await prepare(config, medusa, pt, mock, undo)
    if (medusa.adminToken) secrets.push(medusa.adminToken)
    ctx = {
      ...base,
      recorder,
      mock,
      driver: mock ? new MockDriver(mock) : new HumanDriver(config, pt),
      state,
      undo,
      shared: new Map(),
      inflight: new Set(),
      proved: false,
      aborted: false,
    }
  } catch (e) {
    return finish(1, (e as Error).message)
  }

  try {
    for (const s of scenarios) {
      if (finishing) break
      out(`\n[${s.id}] ${s.title}`)
      const why = s.needs?.(ctx)
      if (why) {
        recorder.add(s.id, "(scenario)", "skipped", why)
        continue
      }
      try {
        await s.run(new T(ctx, s.id))
      } catch (e) {
        if (e instanceof StopRun) return finish(1, e.message)
        if (!(e instanceof EndScenario)) recorder.add(s.id, "(scenario)", "fail", `error: ${(e as Error).message}`)
      }
    }
  } catch (e) {
    return finish(1, (e as Error).message)
  }
  await finish(0)
}

main().catch((e) => {
  const message = (e as Error)?.message ?? String(e)
  say(`${e instanceof ConfigError ? "refusing to run: " : ""}${redact(message, [])}\n`, process.stderr)
  process.exit(2)
})
