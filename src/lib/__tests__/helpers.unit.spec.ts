import { createHmac } from "crypto"
import { printTrailOrderNumber } from "../order-number"
import { buildCreatePayload, type PayloadInput } from "../payload"
import { verifySignature } from "../signature"
import { normaliseSku, resolveSku, skusMatch } from "../sku"

describe("sku", () => {
  it("matches case-insensitively, ignoring surrounding whitespace", () => {
    expect(skusMatch(" abc-1 ", "ABC-1")).toBe(true)
    expect(skusMatch("abc-1", "abc-2")).toBe(false)
    expect(skusMatch(null, "")).toBe(false)
    expect(normaliseSku(" AbC ")).toBe("abc")
  })

  it("resolves the override before the variant SKU", () => {
    expect(resolveSku({ sku: "978-A", metadata: { print_trail_sku: " PT-1 " } })).toBe("PT-1")
    expect(resolveSku({ sku: " 978-A ", metadata: { print_trail_sku: "  " } })).toBe("978-A")
    expect(resolveSku({ sku: null, metadata: null })).toBeNull()
  })

  it("reads a numeric override, as Medusa's admin metadata form saves digits-only values", () => {
    expect(resolveSku({ sku: "plain", metadata: { print_trail_sku: 9780000000026 } })).toBe("9780000000026")
    expect(resolveSku({ sku: "plain", metadata: { print_trail_sku: 12.5 } })).toBe("plain")
    expect(resolveSku({ sku: "plain", metadata: { print_trail_sku: Number.NaN } })).toBe("plain")
    expect(resolveSku({ sku: "plain", metadata: { print_trail_sku: true } })).toBe("plain")
  })
})

describe("verifySignature", () => {
  const body = '{"notificationType":"order-created"}'
  const sig = createHmac("sha256", "s3cret").update(body).digest("hex")

  it("accepts the hex HMAC-SHA256 of the raw body", () => {
    expect(verifySignature(body, sig, "s3cret")).toBe(true)
    expect(verifySignature(Buffer.from(body), sig.toUpperCase(), "s3cret")).toBe(true)
  })

  it("fails closed", () => {
    expect(verifySignature(body, sig, "")).toBe(false)
    expect(verifySignature(body, sig, undefined)).toBe(false)
    expect(verifySignature(body, undefined, "s3cret")).toBe(false)
    expect(verifySignature(body + " ", sig, "s3cret")).toBe(false)
    expect(verifySignature(body, "abc", "s3cret")).toBe(false)
    expect(verifySignature(body, sig, [])).toBe(false)
    expect(verifySignature(body, sig, ["", null])).toBe(false)
  })

  it("accepts a match with any of several secrets", () => {
    expect(verifySignature(body, sig, ["new", "s3cret"])).toBe(true)
    expect(verifySignature(body, sig, ["s3cret", "new"])).toBe(true)
    expect(verifySignature(body, sig, ["new", "old"])).toBe(false)
  })
})

describe("printTrailOrderNumber", () => {
  it("is prefix + display id, with -n after the first", () => {
    expect(printTrailOrderNumber("ORD-", 1042)).toBe("ORD-1042")
    expect(printTrailOrderNumber("ORD-", 1042, 2)).toBe("ORD-1042-2")
    expect(printTrailOrderNumber("", "7")).toBe("7")
  })

  it("refuses an order without a display id", () => {
    expect(() => printTrailOrderNumber("ORD-", "")).toThrow()
  })
})

describe("buildCreatePayload", () => {
  const address = {
    first_name: "Ada",
    last_name: "Lovelace",
    company: null,
    address_1: "1 Analytical St",
    address_2: null,
    city: "London",
    province: "GB-ENG",
    postal_code: "N1 1AA",
    country_code: "gb",
    phone: "0123",
  }
  const base: PayloadInput = {
    orderNumber: "ORD-1",
    strictSkus: true,
    shippingAddress: address,
    billingAddress: null,
    email: "ada@example.com",
    lines: [{ lineItemId: "item_1", sku: "978-A", quantity: 2 }],
  }

  it("maps the order", () => {
    const r = buildCreatePayload({ ...base, orderUrl: "https://admin.example/app/orders/o1" })
    expect(r).toEqual({
      ok: true,
      payload: {
        orderNumber: "ORD-1",
        reserve: false,
        strictSkus: true,
        orderUrl: "https://admin.example/app/orders/o1",
        shippingDetails: {
          postalAddress: {
            companyName: undefined,
            address1: "1 Analytical St",
            address2: undefined,
            city: "London",
            postalCode: "N1 1AA",
            state: { name: "GB-ENG", code: "ENG" },
            country: { code: "GB" },
          },
          deliveryContact: {
            firstName: "Ada",
            lastName: "Lovelace",
            phone: "0123",
            email: "ada@example.com",
          },
          note: undefined,
        },
        orderLines: [{ quantity: 2, lineNumber: "item_1", product: { sku: "978-A" } }],
      },
    })
  })

  it("never asks for a shipping method or a reservation", () => {
    const r = buildCreatePayload(base)
    expect(r.ok && "requestedShippingMethod" in r.payload).toBe(false)
    expect(r.ok && r.payload.reserve).toBe(false)
  })

  it("passes the uuid through when updating a draft", () => {
    const r = buildCreatePayload({ ...base, uuid: "pt-uuid" })
    expect(r.ok && r.payload.uuid).toBe("pt-uuid")
  })

  it("falls back to the whole billing address, never mixing the two", () => {
    const billing = { ...address, address_1: "2 Billing Rd", city: "Leeds", first_name: "Bill" }
    const r = buildCreatePayload({
      ...base,
      shippingAddress: { ...address, country_code: null },
      billingAddress: billing,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.payload.shippingDetails?.postalAddress?.address1).toBe("2 Billing Rd")
      expect(r.payload.shippingDetails?.postalAddress?.city).toBe("Leeds")
      expect(r.payload.shippingDetails?.deliveryContact?.firstName).toBe("Bill")
    }
  })

  it("blocks an incomplete address when billing can't stand in", () => {
    const r = buildCreatePayload({ ...base, shippingAddress: { ...address, country_code: null } })
    expect(r).toMatchObject({ ok: false, reason: "address-incomplete" })
    const noName = buildCreatePayload({
      ...base,
      shippingAddress: { ...address, first_name: null, last_name: null },
    })
    expect(noName).toMatchObject({ ok: false, reason: "address-incomplete" })
  })

  it("accepts a postcode without a city, and a company without a name", () => {
    const r = buildCreatePayload({
      ...base,
      shippingAddress: { ...address, city: null, first_name: null, last_name: null, company: "Acme" },
    })
    expect(r.ok).toBe(true)
  })

  it("keeps only a short state code", () => {
    const r = buildCreatePayload({ ...base, shippingAddress: { ...address, province: "California" } })
    expect(r.ok && r.payload.shippingDetails?.postalAddress?.state).toEqual({ name: "California" })
    const ca = buildCreatePayload({ ...base, shippingAddress: { ...address, province: "us-ca" } })
    expect(ca.ok && ca.payload.shippingDetails?.postalAddress?.state).toEqual({
      name: "us-ca",
      code: "CA",
    })
  })

  it("cuts the customer note to 500 characters", () => {
    const r = buildCreatePayload({ ...base, note: "x".repeat(600) })
    expect(r.ok && r.payload.shippingDetails?.note).toHaveLength(500)
  })

  it("drops zero-quantity and SKU-less lines; none left is no-pt-lines", () => {
    const r = buildCreatePayload({
      ...base,
      lines: [
        { lineItemId: "a", sku: "978-A", quantity: 0 },
        { lineItemId: "b", sku: null, quantity: 1 },
        { lineItemId: "c", sku: "978-C", quantity: 1 },
      ],
    })
    expect(r.ok && r.payload.orderLines).toEqual([
      { quantity: 1, lineNumber: "c", product: { sku: "978-C" } },
    ])
    const none = buildCreatePayload({ ...base, lines: [{ lineItemId: "a", sku: "A", quantity: 0 }] })
    expect(none).toMatchObject({ ok: false, reason: "no-pt-lines" })
  })
})
