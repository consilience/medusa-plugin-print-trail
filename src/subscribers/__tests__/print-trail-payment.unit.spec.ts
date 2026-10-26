import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { resolvePluginOptions } from "../../config"
import { PRINT_TRAIL_MODULE } from "../../modules/printTrail"

const run = jest.fn(async () => ({ result: {} }))
jest.mock("../../workflows/send-order-to-print-trail", () => ({
  sendOrderToPrintTrailWorkflow: () => ({ run }),
}))
jest.mock("../../workflows/run-follow-ups", () => ({ runPrintTrailFollowUps: jest.fn() }))
jest.mock("../../workflows/record-print-trail-order-change", () => ({ recordPrintTrailOrderChangeWorkflow: () => ({ run: jest.fn() }) }))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const handler = require("../print-trail-payment").default

const NOW = Date.now()
const container = (createdAt: string) => {
  const logs: string[] = []
  const registry: Record<string, unknown> = {
    [PRINT_TRAIL_MODULE]: {
      isConnected: async () => true,
      getOptions: async () => resolvePluginOptions({ confirmOn: "payment.captured" }),
      listPrintTrailOrders: async () => [],
    },
    [ContainerRegistrationKeys.LOGGER]: { info: (m: string) => logs.push(m), error: (m: string) => logs.push(m), warn() {} },
    [ContainerRegistrationKeys.QUERY]: {
      graph: async ({ entity }: { entity: string }) => ({
        data:
          entity === "payment"
            ? [{ id: "pay_1", payment_collection: { order: { id: "order_1" } } }]
            : [{ id: "order_1", created_at: createdAt }],
      }),
    },
  }
  return { container: { resolve: (k: string) => registry[k] }, logs }
}

describe("payment.captured with no Print Trail rows", () => {
  beforeEach(() => run.mockClear())

  it("sends a recent order", async () => {
    const { container: c } = container(new Date(NOW - 86_400_000).toISOString())
    await handler({ event: { name: "payment.captured", data: { id: "pay_1" } }, container: c })
    expect(run).toHaveBeenCalledWith({ input: { order_id: "order_1" } })
  })

  it("doesn't send an order older than the lookback, and says so", async () => {
    const { container: c, logs } = container(new Date(NOW - 30 * 86_400_000).toISOString())
    await handler({ event: { name: "payment.captured", data: { id: "pay_1" } }, container: c })
    expect(run).not.toHaveBeenCalled()
    expect(logs.join(" ")).toContain("older than 7 days")
  })
})
