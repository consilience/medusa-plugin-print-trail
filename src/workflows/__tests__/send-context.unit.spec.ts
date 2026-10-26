import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { PRINT_TRAIL_MODULE } from "../../modules/printTrail"
import { buildSendContext } from "../steps/send-context"

describe("buildSendContext", () => {
  // The confirm path's pre-order record must reach the
  // service in production, not only in tests.
  it("marks SKUs seen on pre-order through the service", async () => {
    const service = { markPreOrderSeen: jest.fn(async () => {}), getClient: jest.fn(async () => ({})), getOptions: jest.fn(async () => ({})) }
    const container = { resolve: (key: string) => ({ [PRINT_TRAIL_MODULE]: service, [ContainerRegistrationKeys.LINK]: {} })[key] }
    const ctx = await buildSendContext(container as never)
    await ctx.store.markPreOrderSeen(["PRE-1"])
    expect(service.markPreOrderSeen).toHaveBeenCalledWith(["PRE-1"])
  })

  it("links each new row to its order", async () => {
    const service = {
      createPrintTrailOrders: jest.fn(async (data) => ({ id: "ptord_1", ...data })),
      getClient: jest.fn(async () => ({})),
      getOptions: jest.fn(async () => ({})),
    }
    const link = { create: jest.fn(async () => []) }
    const container = {
      resolve: (key: string) =>
        ({ [PRINT_TRAIL_MODULE]: service, [ContainerRegistrationKeys.LINK]: link })[key],
    }

    const ctx = await buildSendContext(container as never)
    const row = await ctx.store.createPrintTrailOrders({ order_id: "order_1", sequence: 1 })

    expect(row.id).toBe("ptord_1")
    expect(link.create).toHaveBeenCalledWith({
      [PRINT_TRAIL_MODULE]: { print_trail_order_id: "ptord_1" },
      [Modules.ORDER]: { order_id: "order_1" },
    })
  })

  it("creates a missing link for an existing row, and leaves an existing one alone", async () => {
    const service = { getClient: jest.fn(async () => ({})), getOptions: jest.fn(async () => ({})) }
    const linked = new Set<string>(["ptord_linked"])
    const link = {
      list: jest.fn(async (def: Record<string, Record<string, string>>) =>
        linked.has(def[PRINT_TRAIL_MODULE].print_trail_order_id) ? [{}] : []
      ),
      create: jest.fn(async () => []),
    }
    const container = {
      resolve: (key: string) =>
        ({ [PRINT_TRAIL_MODULE]: service, [ContainerRegistrationKeys.LINK]: link })[key],
    }
    const ctx = await buildSendContext(container as never)

    await ctx.store.ensureOrderLink({ id: "ptord_linked", order_id: "order_1", sequence: 1, pt_order_number: "ORD-1" })
    expect(link.create).not.toHaveBeenCalled()

    await ctx.store.ensureOrderLink({ id: "ptord_orphan", order_id: "order_2", sequence: 1, pt_order_number: "ORD-2" })
    expect(link.list).toHaveBeenLastCalledWith({
      [PRINT_TRAIL_MODULE]: { print_trail_order_id: "ptord_orphan" },
      [Modules.ORDER]: { order_id: "order_2" },
    })
    expect(link.create).toHaveBeenCalledWith({
      [PRINT_TRAIL_MODULE]: { print_trail_order_id: "ptord_orphan" },
      [Modules.ORDER]: { order_id: "order_2" },
    })
  })
})
