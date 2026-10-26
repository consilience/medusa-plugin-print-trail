// Constants and the mock for the HTTP harness. The fixture app
// (app/medusa-config.ts) and every spec read these, so the app, the mock and
// the tests agree before Medusa loads its config.
import { startMockPrintTrail, type MockOptions, type MockPrintTrail } from "../../dev/mock-print-trail"

export const HARNESS = {
  port: 4310,
  baseUrl: "http://127.0.0.1:4310",
  appPort: 9310,
  backendUrl: "http://localhost:9310",
  token: "harness-token",
  channelId: "acme-medusa1",
  webhookSecret: "mock-secret",
  jwtSecret: "supersecret",
  prefix: "HAR-",
} as const

// The SKUs the seed uses, with the stock the mock starts with.
export const SKUS = {
  pt: "9780000000002",
  pt2: "9780000000019",
  pod: "9780000000026",
  ptZero: "9780000000033",
  // On pre-order at Print Trail in pre-order.spec.ts (PRE_ORDER_MOCK).
  preOrder: "9780000000040",
  unknownSku: "HAR-UNKNOWN",
} as const

export const HARNESS_STOCK: Record<string, number> = {
  [SKUS.pt]: 25,
  [SKUS.pt2]: 25,
  [SKUS.pod]: 10003,
  // 1 at start, so the seed's stock sync leaves Medusa able to sell one; the
  // shortfall test sets it to 0 before placing the order.
  [SKUS.ptZero]: 1,
  [SKUS.preOrder]: 0,
}

// API 1.3.0: the pre-order SKU's status and publication date at the mock.
// Only pre-order.spec.ts passes these (other specs see an active product at
// 0 stock).
export const PRE_ORDER_DATE = "2026-12-01"
export const PRE_ORDER_MOCK = {
  skuStatus: { [SKUS.preOrder]: "pre-order" as const },
  publicationDate: { [SKUS.preOrder]: PRE_ORDER_DATE },
}

// bootstrap-app.js listens on PORT, so the backend URL is known before the
// config loads.
process.env.PORT = String(HARNESS.appPort)
// Cron never fires inside a test run: tests call the jobs themselves
// (helpers/jobs.ts), and a job firing mid-suite would change counts. Each
// schedule is a daily time twelve hours from now. A far-off date doesn't work:
// the in-memory workflow engine waits with setTimeout, and a delay past 2^31 ms
// (about 24 days) overflows to 1 ms, so the job would fire at once, repeatedly.
const quiet = new Date(Date.now() + 12 * 3600_000)
for (const variable of ["PRINT_TRAIL_SWEEP_SCHEDULE", "PRINT_TRAIL_RECONCILE_SCHEDULE", "PRINT_TRAIL_STOCK_SCHEDULE"]) {
  process.env[variable] = `${quiet.getMinutes()} ${quiet.getHours()} * * *`
}

// The harness must never reach a real Print Trail host.
export function assertLocalPrintTrail(baseUrl: string | undefined): void {
  if (baseUrl !== HARNESS.baseUrl) {
    // eslint-disable-next-line @medusajs/use-medusa-error-not-generic-error
    throw new Error(
      `HTTP harness: refusing Print Trail host ${JSON.stringify(baseUrl)}; only ${HARNESS.baseUrl} (the bundled mock) is allowed`
    )
  }
}

export function harnessOptions(): Record<string, unknown> {
  const extra = JSON.parse(process.env.PT_HARNESS_OPTIONS ?? "{}") as Record<string, unknown>
  return {
    baseUrl: HARNESS.baseUrl,
    channelId: HARNESS.channelId,
    apiToken: HARNESS.token,
    webhookSecret: HARNESS.webhookSecret,
    backendUrl: HARNESS.backendUrl,
    orderNumberPrefix: HARNESS.prefix,
    ...extra,
  }
}

// Starts the mock before the app boots (a top-level beforeAll runs before the
// runner's nested one), resets it before every test and closes it at the end.
export function useMock(opts: MockOptions = {}): () => MockPrintTrail {
  let mock: MockPrintTrail | undefined
  beforeAll(async () => {
    mock = await startMockPrintTrail({
      port: HARNESS.port,
      token: HARNESS.token,
      channelId: HARNESS.channelId,
      webhookSecret: HARNESS.webhookSecret,
      skus: HARNESS_STOCK,
      // The store listens on http://localhost, which Print Trail API 1.2.0
      // refuses as a webhook URL; the mock accepts it (its default, made
      // explicit here).
      allowLocalWebhooks: true,
      ...opts,
    })
  })
  beforeEach(() => mock?.reset())
  afterAll(async () => {
    await mock?.close()
  })
  return () => {
    // eslint-disable-next-line @medusajs/use-medusa-error-not-generic-error
    if (!mock) throw new Error("HTTP harness: the mock isn't running")
    return mock
  }
}
