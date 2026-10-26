import { asValue } from "@medusajs/framework/awilix"
import { ContainerRegistrationKeys, createMedusaContainer, Modules } from "@medusajs/framework/utils"
import { startMockPrintTrail, type MockPrintTrail } from "../../../dev/mock-print-trail"
import { POST } from "../../api/admin/print-trail/stock-sync/route"
import { PostPrintTrailStockSyncSchema } from "../../api/admin/print-trail/validators"
import middlewares from "../../api/middlewares"
import { resolvePluginOptions } from "../../config"
import { STATE_KEYS } from "../../lib/stock"
import { PRINT_TRAIL_MODULE } from "../../modules/printTrail"
import { PrintTrailClient } from "../../modules/printTrail/client/client"
import { requestPrintTrailStockSyncWorkflow } from "../request-print-trail-stock-sync"

jest.setTimeout(20000)

let mock: MockPrintTrail

beforeEach(async () => {
  mock = await startMockPrintTrail({ token: "t", channelId: "acme-medusa1", skus: { "9780000000002": 25 } })
})

afterEach(() => mock.close())

// A Medusa container with the printTrail service over in-memory state, a
// catalogue with one Print Trail profile and no products, and a locking
// module that is free or held.
function setup(opts: { connected?: boolean; stockSync?: boolean; held?: boolean; failStock?: boolean } = {}) {
  const state = new Map<string, unknown>()
  const acquired: unknown[] = []
  const client = new PrintTrailClient({
    baseUrl: opts.failStock ? "http://127.0.0.1:1" : mock.url,
    channelId: "acme-medusa1",
    apiToken: "t",
    retryDelays: [0],
  })
  const service = {
    isConnected: async () => opts.connected ?? true,
    getOptions: async () => resolvePluginOptions({ stockSync: { enabled: opts.stockSync ?? true } }),
    getClient: async () => client,
    getState: async (key: string) => (state.has(key) ? JSON.parse(JSON.stringify(state.get(key))) : null),
    setState: async (key: string, value: unknown) => void state.set(key, value),
    markPreOrderSeen: async () => {},
    variantRowPage: async () => [],
    forgetVariants: async () => 0,
    setCheckStatuses: async () => 0,
    queueStateKeys: async () => {},
    adoptVariantChecks: async () => 0,
  }
  const query = {
    graph: async ({ entity }: { entity: string }) => ({
      data: entity === "shipping_option" ? [{ shipping_profile_id: "sp_pt" }] : [],
    }),
  }
  const container = createMedusaContainer()
  container.register({
    [PRINT_TRAIL_MODULE]: asValue(service),
    [ContainerRegistrationKeys.QUERY]: asValue(query),
    [ContainerRegistrationKeys.LOGGER]: asValue({ info() {}, warn() {}, error() {}, debug() {} }),
    [Modules.LOCKING]: asValue({
      acquire: async (key: unknown) => {
        if (opts.held) throw new Error(`Failed to acquire lock for key "${key}"`)
        acquired.push(key)
      },
      release: async () => true,
    }),
  })
  return { container, state, acquired }
}

const run = (container: ReturnType<typeof setup>["container"], input: { skus?: string[] } = {}) =>
  requestPrintTrailStockSyncWorkflow(container as never).run({ input })

describe("requestPrintTrailStockSyncWorkflow", () => {
  it("runs a full stock sync with the admin trigger", async () => {
    const { container, state, acquired } = setup()
    const { result } = await run(container)
    expect(result.status).toBe("completed")
    expect(acquired).toEqual(["print-trail:stock"])
    expect(state.get(STATE_KEYS.lastRun)).toMatchObject({ trigger: "admin" })
  })

  it("returns each status requestStockSync gives", async () => {
    expect((await run(setup({ connected: false }).container)).result).toEqual({ status: "disabled" })
    expect((await run(setup({ stockSync: false }).container)).result).toEqual({ status: "disabled" })
    const failed = (await run(setup({ failStock: true }).container)).result
    expect(failed).toMatchObject({ status: "failed", error: expect.any(String) })
  })

  it("a held lock gives deferred and records the pending request", async () => {
    const full = setup({ held: true })
    expect((await run(full.container)).result).toEqual({ status: "deferred" })
    expect(full.state.get(STATE_KEYS.pending)).toMatchObject({ full: true, skus: [] })

    const some = setup({ held: true })
    expect((await run(some.container, { skus: ["9780000000002"] })).result).toEqual({ status: "deferred" })
    expect(some.state.get(STATE_KEYS.pending)).toMatchObject({ full: false, skus: ["9780000000002"] })
  })
})

describe("POST /admin/print-trail/stock-sync", () => {
  const post = async (container: ReturnType<typeof setup>["container"]) => {
    let body: unknown
    await POST({ scope: container, validatedBody: {} } as never, { json: (b: unknown) => void (body = b) } as never)
    return body
  }

  it("replies with the status and the run's summary", async () => {
    expect(await post(setup().container)).toEqual({
      status: "completed",
      summary: "0 levels updated, backorders 0 on / 0 off, 0 unmatched SKUs, 0 skipped",
    })
    expect(await post(setup({ held: true }).container)).toEqual({ status: "deferred", summary: "deferred" })
    // A failed run is a result, not an error.
    expect(await post(setup({ failStock: true }).container)).toMatchObject({ status: "failed", summary: expect.stringMatching(/^failed: /) })
  })

  it("rejects a non-empty body", () => {
    expect(PostPrintTrailStockSyncSchema.safeParse({}).success).toBe(true)
    expect(PostPrintTrailStockSyncSchema.safeParse({ skus: ["9780000000002"] }).success).toBe(false)
    expect(PostPrintTrailStockSyncSchema.safeParse({ trigger: "schedule" }).success).toBe(false)
    const route = middlewares.routes?.find((r) => r.matcher === "/admin/print-trail/stock-sync")
    expect(route).toMatchObject({ methods: ["POST"] })
    expect(route?.middlewares).toHaveLength(1)
  })
})
