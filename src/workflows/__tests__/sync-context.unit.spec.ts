import { PRINT_TRAIL_PROVIDER_ID } from "../../lib/lines"
import { buildSyncStore, DISPATCH_ORDER_FIELDS, toDispatchOrder } from "../steps/sync-context"

// The shape query.graph returns for DISPATCH_ORDER_FIELDS (2.17.2).
const graphOrder = {
  id: "order_1",
  status: "pending",
  canceled_at: null,
  items: [
    {
      id: "item_a",
      detail: { quantity: 2, fulfilled_quantity: "1" },
      variant: { product: { shipping_profile: { id: "sp_pt" } } },
    },
    { id: "item_c", detail: { quantity: "1", fulfilled_quantity: 0 }, variant: null },
  ],
  shipping_methods: [{ shipping_option_id: "so_pt" }, { shipping_option_id: "so_manual" }],
  fulfillments: [
    {
      id: "ful_1",
      shipped_at: "2026-10-19T12:00:00.000Z",
      canceled_at: "2026-10-19T13:00:00.000Z",
      metadata: { print_trail_fulfilment_uuid: "f-1" },
      labels: [{ id: "lbl_1", tracking_number: "T1", tracking_url: "u", label_url: "u" }],
    },
  ],
}

describe("toDispatchOrder", () => {
  it("maps the graph order", () => {
    const o = toDispatchOrder(graphOrder, [
      { id: "so_pt", provider_id: PRINT_TRAIL_PROVIDER_ID, shipping_profile_id: "sp_pt" },
      { id: "so_manual", provider_id: "manual_manual", shipping_profile_id: "sp_other" },
    ])
    expect(o).toEqual({
      id: "order_1",
      status: "pending",
      canceled_at: null,
      items: [
        { id: "item_a", quantity: 2, fulfilled_quantity: 1, shipping_profile_id: "sp_pt" },
        { id: "item_c", quantity: 1, fulfilled_quantity: 0, shipping_profile_id: null },
      ],
      fulfillments: [
        {
          id: "ful_1",
          shipped_at: "2026-10-19T12:00:00.000Z",
          canceled_at: "2026-10-19T13:00:00.000Z",
          metadata: { print_trail_fulfilment_uuid: "f-1" },
          labels: [{ id: "lbl_1", tracking_number: "T1", tracking_url: "u", label_url: "u" }],
        },
      ],
      ptOptionIdByProfile: { sp_pt: "so_pt" },
    })
  })

  it("selects the detail quantities, not items.quantity", () => {
    expect(DISPATCH_ORDER_FIELDS).toEqual(
      expect.arrayContaining(["items.detail.quantity", "items.detail.fulfilled_quantity", "fulfillments.labels.id"])
    )
  })
})

// The sync path's pre-order record must reach the service.
describe("buildSyncStore", () => {
  it("marks SKUs seen on pre-order through the service", async () => {
    const service = { markPreOrderSeen: jest.fn(async () => {}) }
    await buildSyncStore(service as never).markPreOrderSeen(["PRE-1"])
    expect(service.markPreOrderSeen).toHaveBeenCalledWith(["PRE-1"])
  })
})
