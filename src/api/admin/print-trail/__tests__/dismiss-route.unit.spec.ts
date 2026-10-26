const run = jest.fn(async () => ({ result: { dismissed: true } }))
jest.mock("../../../../workflows/dismiss-print-trail-attention", () => ({
  dismissPrintTrailAttentionWorkflow: () => ({ run }),
}))

import { POST } from "../orders/[id]/dismiss/route"

const row = { id: "ptord_1", order_id: "order_gone", sequence: 1, pt_order_number: "ORD-1", attention: "complete-manually" }

const scope = {
  resolve: (key: string) => {
    if (key === "printTrail") return { listPrintTrailOrders: async (f: { order_id: string }) => (f.order_id === row.order_id ? [row] : []) }
    if (key === "query") return { graph: async () => ({ data: [] }) } // the order was deleted
    throw new Error(`unexpected ${key}`)
  },
}

const reply = () => {
  const res: { statusCode: number; body: unknown; status: (n: number) => typeof res; json: (b: unknown) => typeof res } = {
    statusCode: 200,
    body: null,
    status(n) {
      this.statusCode = n
      return this
    },
    json(b) {
      this.body = b
      return this
    },
  }
  return res
}

describe("POST orders/:id/dismiss", () => {
  it("dismisses an attention row whose order was deleted", async () => {
    const res = reply()
    await POST(
      { params: { id: "order_gone" }, scope, validatedBody: { print_trail_order_id: "ptord_1", attention: "complete-manually" } } as never,
      res as never
    )
    expect(res.body).toEqual({ status: "dismissed" })
    expect(run).toHaveBeenCalledWith({ input: { order_id: "order_gone", print_trail_order_id: "ptord_1", attention: "complete-manually", lock_timeout: 0 } })
  })

  it("refuses a row of another order", async () => {
    await expect(
      POST({ params: { id: "order_other" }, scope, validatedBody: { print_trail_order_id: "ptord_1", attention: "complete-manually" } } as never, reply() as never)
    ).rejects.toThrow("isn't on this order")
  })
})
