import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { PRINT_TRAIL_MODULE } from "../../modules/printTrail"
import { normaliseSku } from "../../lib/sku"
import { readUnmatchedSkus, STATE_KEYS, STOCK_LOCK_KEY } from "../../lib/stock"
import { UNMATCHED_FORGET_WAITS_MS } from "../../lib/stock-flow"
import handler, { config } from "../print-trail-variant-deleted"

type Row = { variant_id: string; product_id: string; check_sku: string; check_status: string }

// A deleted variant's row goes, so its not-found SKU leaves the notice; and
// its SKU leaves the stock sync's list too, unless another row still has it.
describe("print-trail-variant-deleted", () => {
  const setup = (rows: Row[], opts: { fail?: "forget" | "state"; unmatched?: string[] } = {}) => {
    const state = new Map<string, unknown>()
    if (opts.unmatched) state.set(STATE_KEYS.unmatched, { skus: opts.unmatched, updatedAt: "2026-10-26T03:00:00.000Z" })
    const matches = (r: Row, filter: { variantIds?: string[]; productIds?: string[] }) =>
      !!filter.variantIds?.includes(r.variant_id) || !!filter.productIds?.includes(r.product_id)
    const service = {
      rows,
      // Runs whether or not the plugin is connected.
      isConnected: jest.fn(async () => false),
      checkSkusOf: jest.fn(async (filter: { variantIds?: string[]; productIds?: string[] }) => [
        ...new Set(service.rows.filter((r) => matches(r, filter)).map((r) => r.check_sku)),
      ]),
      forgetVariants: jest.fn(async (filter: { variantIds?: string[]; productIds?: string[] }) => {
        if (opts.fail === "forget") throw new Error("database gone")
        const before = service.rows.length
        service.rows = service.rows.filter((r) => !matches(r, filter))
        return before - service.rows.length
      }),
      checkedSkus: jest.fn(async (skus: string[]) => skus.filter((s) => service.rows.some((r) => normaliseSku(r.check_sku) === normaliseSku(s)))),
      getState: jest.fn(async (key: string) => {
        if (opts.fail === "state") throw new Error("state store gone")
        return (state.get(key) as never) ?? null
      }),
      setState: jest.fn(async (key: string, value: unknown) => {
        state.set(key, value)
      }),
      notFoundSkus: async () => service.rows.filter((r) => r.check_status === "not-found").map((r) => r.check_sku),
    }
    const held = new Set<string>()
    const locking = {
      acquire: jest.fn(async (key: string) => {
        if (held.has(key)) throw new Error(`Failed to acquire lock for key "${key}"`)
        held.add(key)
      }),
      release: jest.fn(async (key: string) => {
        held.delete(key)
      }),
    }
    const logger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const container = {
      resolve: (key: string) =>
        ({ [PRINT_TRAIL_MODULE]: service, [ContainerRegistrationKeys.LOGGER]: logger, [Modules.LOCKING]: locking })[key],
    }
    const send = (name: string, id: string) => handler({ event: { name, data: { id } }, container } as never)
    const stockList = () => (state.get(STATE_KEYS.unmatched) as { skus: string[] } | undefined)?.skus
    return { service, logger, locking, held, send, stockList }
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

  it("the deleted rows' SKUs leave the stock sync's list too, under the stock lock", async () => {
    const { service, locking, held, send, stockList } = setup(rows, { unmatched: ["MISSING-1", "MISSING-2", "MISSING-3", "OTHER"] })
    await send("product.deleted", "prod_1")
    expect(stockList()).toEqual(["MISSING-3", "OTHER"])
    expect(await readUnmatchedSkus(service)).toEqual(["MISSING-3", "OTHER"])
    expect(locking.acquire).toHaveBeenCalledWith(STOCK_LOCK_KEY, expect.objectContaining({ ownerId: expect.any(String), expire: expect.any(Number) }))
    expect(held.size).toBe(0)
  })

  it("a SKU another row still has stays in the stock sync's list, however it is cased", async () => {
    const shared: Row[] = [
      ...rows,
      { variant_id: "variant_4", product_id: "prod_3", check_sku: " missing-1 ", check_status: "not-found" },
    ]
    const { service, send, stockList } = setup(shared, { unmatched: ["MISSING-1", "MISSING-2", "MISSING-3"] })
    await send("product.deleted", "prod_1")
    expect(service.checkedSkus).toHaveBeenCalledWith(["MISSING-1", "MISSING-2"])
    expect(stockList()).toEqual(["MISSING-1", "MISSING-3"])
  })

  it("waits out a moment's hold on the stock lock, as another deletion's", async () => {
    const { locking, held, send, stockList } = setup(rows, { unmatched: ["MISSING-1", "MISSING-3"] })
    held.add(STOCK_LOCK_KEY)
    locking.acquire.mockImplementationOnce(async (key: string) => {
      held.delete(key)
      throw new Error(`Failed to acquire lock for key "${key}"`)
    })
    await send("product-variant.deleted", "variant_3")
    expect(locking.acquire).toHaveBeenCalledTimes(2)
    expect(stockList()).toEqual(["MISSING-1"])
  })

  it("leaves the stock sync's list to the next full sync while the stock lock stays held", async () => {
    const { service, locking, held, logger, send, stockList } = setup(rows, { unmatched: ["MISSING-1", "MISSING-3"] })
    held.add(STOCK_LOCK_KEY)
    jest.useFakeTimers()
    try {
      const sent = send("product-variant.deleted", "variant_3")
      await jest.advanceTimersByTimeAsync(5_000)
      await expect(sent).resolves.toBeUndefined()
    } finally {
      jest.useRealTimers()
    }
    // A few tries, then it gives up without waiting on the lock.
    expect(locking.acquire).toHaveBeenCalledTimes(UNMATCHED_FORGET_WAITS_MS.length + 1)
    // The row is gone at once all the same.
    expect(service.rows.map((r) => r.variant_id)).toEqual(["variant_1", "variant_2"])
    expect(stockList()).toEqual(["MISSING-1", "MISSING-3"])
    expect(service.setState).not.toHaveBeenCalled()
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("MISSING-3"))
    expect(logger.error).not.toHaveBeenCalled()
    // Still held by its owner.
    expect(held.has(STOCK_LOCK_KEY)).toBe(true)
  })

  it("writes nothing when the stock sync's list hasn't the SKU, or there is none", async () => {
    const listed = setup(rows, { unmatched: ["OTHER"] })
    await listed.send("product-variant.deleted", "variant_3")
    expect(listed.service.setState).not.toHaveBeenCalled()
    const none = setup(rows)
    await none.send("product-variant.deleted", "variant_3")
    expect(none.service.setState).not.toHaveBeenCalled()
  })

  it("a variant without a row takes no lock", async () => {
    const { locking, send } = setup(rows, { unmatched: ["MISSING-1"] })
    await send("product-variant.deleted", "variant_never_checked")
    expect(locking.acquire).not.toHaveBeenCalled()
  })

  it("logs a failure and doesn't throw", async () => {
    const { send, logger } = setup(rows, { fail: "forget" })
    await expect(send("product.deleted", "prod_1")).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("database gone"))
  })

  it("logs a failure to update the stock sync's list, releases the lock and doesn't throw", async () => {
    const { service, held, send, logger } = setup(rows, { fail: "state", unmatched: ["MISSING-3"] })
    await expect(send("product-variant.deleted", "variant_3")).resolves.toBeUndefined()
    expect(service.rows.map((r) => r.variant_id)).toEqual(["variant_1", "variant_2"])
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("state store gone"))
    expect(held.size).toBe(0)
  })

  it("ignores an event without an id", async () => {
    const { service } = setup(rows)
    const container = { resolve: () => service }
    await handler({ event: { name: "product.deleted", data: {} }, container } as never)
    expect(service.forgetVariants).not.toHaveBeenCalled()
  })
})
