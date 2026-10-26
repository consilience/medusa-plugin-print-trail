import { buildShipmentNotification, type ShipmentFulfillment } from "../shipment-email"

const fulfillment = (over: Partial<ShipmentFulfillment> = {}): ShipmentFulfillment => ({
  id: "ful_1",
  metadata: { print_trail_fulfilment_uuid: "f-1", carrier: "Royal Mail", order_id: "order_1" },
  items: [{ line_item_id: "item_a", title: "Book", quantity: "2" }],
  labels: [
    { tracking_number: "T2", tracking_url: "https://rm.example/T2" },
    { tracking_number: "T1", tracking_url: "https://rm.example/T1" },
  ],
  ...over,
})
const order = { id: "order_1", display_id: 1001, email: "ada@example.com" }

describe("buildShipmentNotification", () => {
  it("builds the email for a Print Trail parcel", () => {
    expect(
      buildShipmentNotification({ fulfillment: fulfillment(), order, template: "print-trail-shipment", ptOrderNumber: "ORD-1001" })
    ).toEqual({
      to: "ada@example.com",
      channel: "email",
      template: "print-trail-shipment",
      trigger_type: "shipment.created",
      resource_type: "fulfillment",
      resource_id: "ful_1",
      idempotency_key: "print-trail-shipment:ful_1:T1,T2",
      data: {
        order: { id: "order_1", display_id: 1001 },
        print_trail_order_number: "ORD-1001",
        carrier: "Royal Mail",
        items: [{ line_item_id: "item_a", title: "Book", quantity: 2 }],
        tracking: [
          { number: "T2", url: "https://rm.example/T2" },
          { number: "T1", url: "https://rm.example/T1" },
        ],
        pre_order: false,
      },
      content: {
        subject: "Your order #1001 is on its way",
        html: expect.stringContaining('<a href="https://rm.example/T1">T1</a>'),
        text: expect.stringContaining("- 2 × Book"),
      },
    })
  })

  it("marks and words a pre-order parcel", () => {
    const n = buildShipmentNotification({ fulfillment: fulfillment(), order, template: "print-trail-shipment", preOrder: true })
    expect(n?.data).toMatchObject({ pre_order: true })
    expect(n?.content).toMatchObject({ subject: "Your pre-order from order #1001 has shipped" })
    // Same key as an ordinary parcel: the wording isn't part of it.
    expect(n?.idempotency_key).toBe("print-trail-shipment:ful_1:T1,T2")
  })

  it("render: false sends template and data only", () => {
    const n = buildShipmentNotification({ fulfillment: fulfillment(), order, template: "t", render: false })
    expect(n && "content" in n).toBe(false)
    expect(n?.data).toBeTruthy()
  })

  it("ignores fulfilments without print_trail_fulfilment_uuid", () => {
    expect(buildShipmentNotification({ fulfillment: fulfillment({ metadata: {} }), order, template: "t" })).toBeNull()
    expect(buildShipmentNotification({ fulfillment: fulfillment({ metadata: null }), order, template: "t" })).toBeNull()
  })

  it("skips an order with no email", () => {
    expect(buildShipmentNotification({ fulfillment: fulfillment(), order: { ...order, email: "" }, template: "t" })).toBeNull()
    expect(
      buildShipmentNotification({ fulfillment: fulfillment({ labels: [{ tracking_number: "", tracking_url: "" }] }), order, template: "t" })
    ).toBeNull()
  })

  it("keys a late-tracking email on the added numbers only", () => {
    const n = buildShipmentNotification({
      fulfillment: fulfillment(),
      order,
      template: "t",
      only: [{ tracking_number: "T3", tracking_url: "https://rm.example/T3", label_url: "https://rm.example/T3" }],
    })
    expect(n?.idempotency_key).toBe("print-trail-shipment:ful_1:T3")
    expect(n?.data?.tracking).toEqual([{ number: "T3", url: "https://rm.example/T3" }])
  })

  it("keys the same parcel the same way twice", () => {
    const a = buildShipmentNotification({ fulfillment: fulfillment(), order, template: "t" })
    const b = buildShipmentNotification({
      fulfillment: fulfillment({ labels: [...fulfillment().labels].reverse() }),
      order,
      template: "t",
    })
    expect(a?.idempotency_key).toBe(b?.idempotency_key)
  })
})
