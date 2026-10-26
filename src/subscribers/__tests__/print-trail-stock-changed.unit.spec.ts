import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { PRINT_TRAIL_MODULE } from "../../modules/printTrail"
import handler from "../print-trail-stock-changed"

// The activation scan reads open rows only for SKUs the store has seen held
// at Print Trail (pre-order, inactive or out-of-stock; Print Trail puts a
// status on every stock item).
describe("print-trail-stock-changed", () => {
  const run = async (seen: string[], activated: string[], held: { sku: string; status: string }[] = []) => {
    const marked: string[] = []
    const service = {
      // Not connected: the stock sync is skipped (requestStockSync).
      isConnected: async () => false,
      markPreOrderSeen: jest.fn(async (skus: string[]) => void marked.push(...skus)),
      preOrderSeen: jest.fn(async (skus: string[]) => skus.filter((s) => seen.includes(s) || marked.includes(s))),
      listPrintTrailOrders: jest.fn(async () => []),
    }
    const logger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const container = {
      resolve: (key: string) => ({ [PRINT_TRAIL_MODULE]: service, [ContainerRegistrationKeys.LOGGER]: logger })[key],
    }
    await handler({ event: { data: { changed_at: null, activated_skus: activated, held_skus: held } }, container } as never)
    return service
  }

  it("scans no rows for a SKU never seen on pre-order", async () => {
    const service = await run([], ["978-A"])
    expect(service.preOrderSeen).toHaveBeenCalledWith(["978-A"])
    expect(service.listPrintTrailOrders).not.toHaveBeenCalled()
  })

  it("scans for a SKU seen on pre-order", async () => {
    const service = await run(["PRE-1"], ["978-A", "PRE-1"])
    expect(service.listPrintTrailOrders).toHaveBeenCalledTimes(1)
  })

  // An active product with out-of-stock back-orders set to
  // pre-order for the first time. The item itself says it's on pre-order.
  it("records a pre-order item as seen before the scan, and scans for it", async () => {
    const service = await run([], [], [{ sku: "OOS-1", status: "pre-order" }])
    expect(service.markPreOrderSeen).toHaveBeenCalledWith(["OOS-1"])
    expect(service.listPrintTrailOrders).toHaveBeenCalledTimes(1)
  })

  it("scans for an inactive item only when it was seen", async () => {
    const unseen = await run([], [], [{ sku: "I-1", status: "inactive" }])
    expect(unseen.markPreOrderSeen).not.toHaveBeenCalled()
    expect(unseen.listPrintTrailOrders).not.toHaveBeenCalled()
    const seen = await run(["I-1"], [], [{ sku: "I-1", status: "inactive" }])
    expect(seen.listPrintTrailOrders).toHaveBeenCalledTimes(1)
  })

  it("scans once for a mixed event", async () => {
    const service = await run(["PRE-1"], ["PRE-1"], [{ sku: "OOS-1", status: "pre-order" }])
    expect(service.listPrintTrailOrders).toHaveBeenCalledTimes(1)
  })
})
