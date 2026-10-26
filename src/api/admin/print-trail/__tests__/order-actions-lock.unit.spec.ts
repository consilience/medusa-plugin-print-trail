// Admin actions fail fast on a held lock (409 busy) instead of waiting.
// Function declarations: jest hoists the mock factories above any const.
function mockCalls(): Record<string, unknown[]> {
  const g = globalThis as { __ptCalls?: Record<string, unknown[]> }
  return (g.__ptCalls ??= {})
}
function fake(name: string, result: unknown) {
  return () => ({
    run: async (args: { input: unknown }) => {
      ;(mockCalls()[name] ??= []).push(args.input)
      return { result }
    },
  })
}
jest.mock("../../../../workflows/sync-print-trail-order", () => ({
  syncPrintTrailOrderWorkflow: fake("sync", { refetch: { outcome: "synced", changes: [] }, dispatch: { created: [] } }),
}))
jest.mock("../../../../workflows/send-order-to-print-trail", () => ({
  sendOrderToPrintTrailWorkflow: fake("send", { create: { outcome: "draft", blockReason: null }, gate: { ok: true }, confirm: { outcome: "confirmed" } }),
}))
jest.mock("../../../../workflows/reset-print-trail-retry", () => ({ resetPrintTrailRetryWorkflow: fake("reset", { reset: true }) }))
jest.mock("../../../../workflows/dismiss-print-trail-attention", () => ({ dismissPrintTrailAttentionWorkflow: fake("dismiss", { dismissed: true }) }))

import { POST as dismiss } from "../orders/[id]/dismiss/route"
import { POST as refresh } from "../orders/[id]/refresh/route"
import { POST as resend } from "../orders/[id]/resend/route"

const row = { id: "ptord_1", order_id: "order_1", sequence: 1, pt_order_number: "ORD-1", pt_uuid: "u1", attention: "retry-cap:send", confirmed_at: null, status: "draft" }
const scope = {
  resolve: (key: string) => {
    if (key === "printTrail") return { listPrintTrailOrders: async () => [row] }
    if (key === "query") return { graph: async () => ({ data: [{ id: "order_1", display_id: 1, status: "pending", shipping_methods: [] }] }) }
    throw new Error(`unexpected ${key}`)
  },
}
const res = () => ({ status: () => res(), json: () => undefined })
const req = (body: unknown) => ({ params: { id: "order_1" }, scope, validatedBody: body }) as never

describe("admin order actions take the lock without waiting", () => {
  it("passes lock_timeout 0 to every workflow they run", async () => {
    await refresh(req({}), res() as never)
    await resend(req({ print_trail_order_id: "ptord_1", as_new: false }), res() as never)
    await dismiss(req({ print_trail_order_id: "ptord_1", attention: "complete-manually" }), res() as never)
    for (const name of ["sync", "reset", "send", "dismiss"]) {
      expect(mockCalls()[name]?.length).toBeGreaterThan(0)
      for (const input of mockCalls()[name]) expect(input).toMatchObject({ lock_timeout: 0 })
    }
  })
})
