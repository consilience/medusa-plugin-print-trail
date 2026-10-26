import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { PRINT_TRAIL_MODULE } from "../../modules/printTrail"
import handler, { config } from "../print-trail-stock-shortfall"

jest.mock("../../lib/stock-request", () => ({
  requestStockSync: jest.fn(async () => ({ status: "disabled" })),
  describeStockResult: () => "disabled",
}))
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { requestStockSync } = require("../../lib/stock-request") as { requestStockSync: jest.Mock }

// An amend refused for stock (Print Trail's 409 stock-held) gets the same
// SKU-only refresh as a confirm shortfall.
describe("print-trail-stock-shortfall", () => {
  const container = {
    resolve: (key: string) =>
      ({
        [PRINT_TRAIL_MODULE]: { listPrintTrailOrders: jest.fn(async () => []) },
        [ContainerRegistrationKeys.LOGGER]: { info: jest.fn(), error: jest.fn() },
      })[key],
  }
  beforeEach(() => requestStockSync.mockClear())

  it("listens for an amend refused for stock", () => {
    expect(config.event).toContain("print_trail.order.stock_held")
  })

  it("refreshes the refused SKUs", async () => {
    await handler({
      event: { name: "print_trail.order.stock_held", data: { order_id: "o1", print_trail_order_id: "r1", skus: ["PRE-1"] } },
      container,
    } as never)
    expect(requestStockSync).toHaveBeenCalledWith(container, { trigger: "shortfall", skus: ["PRE-1"] })
  })

  it("does nothing for other attention", async () => {
    await handler({
      event: { name: "print_trail.order.attention", data: { order_id: "o1", print_trail_order_id: "r1", attention: "amend-refused" } },
      container,
    } as never)
    expect(requestStockSync).not.toHaveBeenCalled()
  })
})
