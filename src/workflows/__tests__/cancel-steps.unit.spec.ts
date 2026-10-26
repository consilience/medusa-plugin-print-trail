import type { MockPrintTrail } from "../../../dev/mock-print-trail"
import { requestCancel } from "../../lib/cancel-flow"
import { flowClient, flowOptions, MemoryStore, NOW, placeAtMock, startFlowMock } from "../../lib/__tests__/flow-fixtures"
import { cancelPrintTrailRows } from "../steps/cancel-print-trail-rows"
import { recordCancelIntent } from "../steps/record-cancel-intent"
import { fakeContainer } from "./fake-container"

let mock: MockPrintTrail
let store: MemoryStore

beforeEach(async () => {
  mock = await startFlowMock()
  store = new MemoryStore()
})
afterEach(() => mock.close())

const harness = (canceledAt: string | null) =>
  fakeContainer({
    store,
    client: flowClient(mock),
    options: flowOptions(mock),
    orders: { order_1: { id: "order_1", display_id: 1001, canceled_at: canceledAt } },
  })

describe("cancel workflow steps", () => {
  it("a retried cancel of an emptied draft never touches a live sibling row", async () => {
    const emptied = await placeAtMock(mock, store)
    const claim = await placeAtMock(mock, store, { orderNumber: "ORD-1001-2", sequence: 2, sourceRef: "claim:c1" })
    // The amend flow emptied row 1 and asked for its cancel; Print Trail was down.
    await requestCancel(store, [emptied], "no-pt-lines", NOW)
    mock.fail(/\/cancel$/, 503, { message: "down" }, 2)
    const { container } = harness(null)
    await recordCancelIntent({ order_id: "order_1", cause: "order-canceled" }, container)
    await cancelPrintTrailRows({ order_id: "order_1" }, container)
    expect(store.row(emptied.id).cancel_status).toBe("requested")
    // The sweep retries it once due.
    await store.updatePrintTrailOrders({ id: emptied.id, next_attempt_at: new Date(0) })
    await recordCancelIntent({ order_id: "order_1", cause: "order-canceled" }, container)
    await cancelPrintTrailRows({ order_id: "order_1" }, container)
    expect(store.row(emptied.id).cancel_status).toBe("cancelled")
    expect(store.row(claim.id)).toMatchObject({ cancel_status: null, cancel_requested: false })
    expect(store.kinds(claim.id)).toEqual([])
    expect(mock.state.orders.get(claim.pt_uuid!).status).not.toBe("cancelled")
    const cancelRequested = store.events.filter((e) => e.kind === "cancel-requested")
    expect(cancelRequested.map((e) => e.data.cause)).toEqual(["no-pt-lines"])
  })

  it("a Medusa-cancelled order cancels every row", async () => {
    const one = await placeAtMock(mock, store)
    const two = await placeAtMock(mock, store, { orderNumber: "ORD-1001-2", sequence: 2, sourceRef: "claim:c1" })
    const { container } = harness("2026-10-19T11:00:00Z")
    await recordCancelIntent({ order_id: "order_1", cause: "order-canceled" }, container)
    await cancelPrintTrailRows({ order_id: "order_1" }, container)
    expect([store.row(one.id).cancel_status, store.row(two.id).cancel_status]).toEqual(["cancelled", "cancelled"])
  })

  it("cancels at most the rows a lock's ttl allows, leaving the rest due", async () => {
    const rows: Awaited<ReturnType<typeof placeAtMock>>[] = []
    for (let n = 1; n <= 3; n++) rows.push(await placeAtMock(mock, store, { orderNumber: `ORD-1001${n > 1 ? `-${n}` : ""}`, sequence: n }))
    const { container } = harness("2026-10-19T11:00:00Z")
    await recordCancelIntent({ order_id: "order_1", cause: "order-canceled" }, container)
    await cancelPrintTrailRows({ order_id: "order_1" }, container)
    expect(rows.map((r) => store.row(r.id).cancel_status)).toEqual(["cancelled", "cancelled", "requested"])
    await cancelPrintTrailRows({ order_id: "order_1" }, container)
    expect(store.row(rows[2].id).cancel_status).toBe("cancelled")
  })
})
