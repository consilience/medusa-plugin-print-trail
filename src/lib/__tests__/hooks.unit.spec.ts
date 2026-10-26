import { resolvePluginOptions } from "../../config"
import type { PtCreateOrderRequest } from "../../modules/printTrail/client/types"
import { acceptOrderNumber, mergePayloadOverride, preparePayload } from "../hooks"
import { addressFingerprint } from "../order-scope"

const payload = (): PtCreateOrderRequest => ({
  orderNumber: "ORD-1001",
  reserve: false,
  strictSkus: true,
  uuid: "u1",
  orderUrl: "https://admin.example/app/orders/order_1",
  shippingDetails: { postalAddress: { address1: "1 Analytical St", country: { code: "GB" } } } as never,
  orderLines: [{ quantity: 1, lineNumber: "item_1", product: { sku: "978-A" } }],
})

describe("acceptOrderNumber", () => {
  it("falls back to the default order number when the hook returns an unusable one", () => {
    for (const junk of ["", "  ", 42, "x".repeat(101), null, { orderNumber: "" }]) {
      const out = acceptOrderNumber(junk, "ORD-1001-2", ["ORD-1001"])
      expect(out.orderNumber).toBe("ORD-1001-2")
      expect(out.warning).toBeTruthy()
    }
    const taken = acceptOrderNumber("ORD-1001", "ORD-1001-2", ["ORD-1001"])
    expect(taken).toMatchObject({ orderNumber: "ORD-1001-2" })
    expect(taken.warning).toContain("another Print Trail order")
    expect(acceptOrderNumber(" ORD-X ", "ORD-1001-2", ["ORD-1001"])).toEqual({ orderNumber: "ORD-X" })
    expect(acceptOrderNumber({ orderNumber: "ORD-Y" }, "ORD-1001-2", [])).toEqual({ orderNumber: "ORD-Y" })
  })

  it("uses the default silently when no handler is registered", () => {
    expect(acceptOrderNumber(undefined, "ORD-1001", [])).toEqual({ orderNumber: "ORD-1001" })
  })
})

describe("mergePayloadOverride", () => {
  it("keeps the plugin's lines, number and flags whatever the payload hook returns", () => {
    const out = mergePayloadOverride(payload(), {
      payload: {
        orderLines: [],
        orderNumber: "OTHER",
        reserve: true,
        strictSkus: false,
        uuid: "u2",
        requestedShippingMethod: "express",
        purchaseOrder: "PO-1",
      },
    })
    expect(out.payload).toEqual({ ...payload(), purchaseOrder: "PO-1" })
    expect(out.warning).toBeUndefined()
  })

  it("lets the hook change the address, Print Trail number and order URL", () => {
    const shippingDetails = { postalAddress: { address1: "2 Other St", country: { code: "GB" } } }
    const out = mergePayloadOverride(payload(), {
      shippingDetails,
      printTrailOrderNumber: "PT-1",
      orderUrl: "https://x.example",
    })
    expect(out.payload).toMatchObject({ shippingDetails, printTrailOrderNumber: "PT-1", orderUrl: "https://x.example" })
  })

  it("ignores a non-object override with a warning, and nothing at all silently", () => {
    expect(mergePayloadOverride(payload(), "junk")).toMatchObject({ payload: payload(), warning: expect.any(String) })
    expect(mergePayloadOverride(payload(), undefined)).toEqual({ payload: payload() })
  })
})

describe("preparePayload", () => {
  const options = resolvePluginOptions({ adminUrl: "https://admin.example/app" })
  const order = {
    id: "order_1",
    display_id: 1001,
    email: "ada@example.com",
    shipping_address: { first_name: "Ada", address_1: "1 St", city: "London", country_code: "gb" },
  }

  it("builds the payload and fingerprints its address", () => {
    const out = preparePayload({ order, lines: [{ lineItemId: "i1", sku: "978-A", quantity: 1, method: "standard" }], orderNumber: "ORD-1001", options })
    if (!out.ok) throw new Error(out.detail)
    expect(out.payload.orderUrl).toBe("https://admin.example/app/orders/order_1")
    expect(out.addressHash).toBe(addressFingerprint(out.payload.shippingDetails))
  })

  it("refuses an incomplete address", () => {
    expect(preparePayload({ order: { ...order, shipping_address: null }, lines: [], orderNumber: "ORD-1001", options })).toMatchObject({
      ok: false,
      reason: "address-incomplete",
    })
  })
})
