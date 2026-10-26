import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { PRINT_TRAIL_MODULE } from "../../modules/printTrail"
import { readUnmatchedSkus } from "../../lib/stock"
import handler, { config } from "../print-trail-variant-deleted"

type Row = { variant_id: string; product_id: string; check_sku: string; check_status: string }

// A deleted variant's row goes, so its not-found SKU leaves the notice.
describe("print-trail-variant-deleted", () => {
  const setup = (rows: Row[], opts: { fail?: boolean } = {}) => {
    const service = {
      rows,
      // Runs whether or not the plugin is connected.
      isConnected: jest.fn(async () => false),
      forgetVariants: jest.fn(async (filter: { variantIds?: string[]; productIds?: string[] }) => {
        if (opts.fail) throw new Error("database gone")
        const before = service.rows.length
        service.rows = service.rows.filter(
          (r) => !filter.variantIds?.includes(r.variant_id) && !filter.productIds?.includes(r.product_id)
        )
        return before - service.rows.length
      }),
      getState: async () => null,
      notFoundSkus: async () => service.rows.filter((r) => r.check_status === "not-found").map((r) => r.check_sku),
    }
    const logger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const container = {
      resolve: (key: string) => ({ [PRINT_TRAIL_MODULE]: service, [ContainerRegistrationKeys.LOGGER]: logger })[key],
    }
    const send = (name: string, id: string) => handler({ event: { name, data: { id } }, container } as never)
    return { service, logger, send }
  }

  const rows: Row[] = [
    { variant_id: "variant_1", product_id: "prod_1", check_sku: "MISSING-1", check_status: "not-found" },
    { variant_id: "variant_2", product_id: "prod_1", check_sku: "MISSING-2", check_status: "not-found" },
    { variant_id: "variant_3", product_id: "prod_2", check_sku: "MISSING-3", check_status: "not-found" },
  ]

  it("listens for variant and product deletions", () => {
    expect(config.event).toEqual(["product-variant.deleted", "product.deleted"])
  })

  it("a deleted variant's row is deleted", async () => {
    const { service, send } = setup(rows)
    await send("product-variant.deleted", "variant_3")
    expect(service.forgetVariants).toHaveBeenCalledWith({ variantIds: ["variant_3"] })
    expect(service.rows.map((r) => r.variant_id)).toEqual(["variant_1", "variant_2"])
  })

  it("a deleted product's rows are deleted", async () => {
    const { service, send } = setup(rows)
    await send("product.deleted", "prod_1")
    expect(service.forgetVariants).toHaveBeenCalledWith({ productIds: ["prod_1"] })
    expect(service.rows.map((r) => r.variant_id)).toEqual(["variant_3"])
  })

  it("the notice drops a deleted variant's not-found SKU", async () => {
    const { service, send } = setup(rows)
    expect(await readUnmatchedSkus(service)).toEqual(["MISSING-1", "MISSING-2", "MISSING-3"])
    await send("product-variant.deleted", "variant_2")
    expect(await readUnmatchedSkus(service)).toEqual(["MISSING-1", "MISSING-3"])
  })

  it("logs a failure and doesn't throw", async () => {
    const { send, logger } = setup(rows, { fail: true })
    await expect(send("product.deleted", "prod_1")).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("database gone"))
  })

  it("ignores an event without an id", async () => {
    const { service } = setup(rows)
    const container = { resolve: () => service }
    await handler({ event: { name: "product.deleted", data: {} }, container } as never)
    expect(service.forgetVariants).not.toHaveBeenCalled()
  })
})
