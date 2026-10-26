import { cancelTooLateContent, cancelTooLateSubject } from "../cancel-too-late"
import { escapeHtml, isHttpUrl } from "../html"
import { shipmentContent } from "../shipment"

const data = {
  order: { id: "order_01", display_id: 42 },
  print_trail_order_number: "ORD-42",
  pt_url: "https://app.printtrail.com/orders/ORD-42",
  admin_order_url: "https://shop.example.com/app/orders/order_01",
  why: "partial",
  fulfilments: [
    { number: "F1", status: "dispatched", tracking: [{ number: "RM123", url: "https://track.example/RM123", carrier: "Royal Mail" }] },
    { number: "F2", status: "failed", tracking: [] },
  ],
}

describe("print-trail-cancel-too-late email", () => {
  it("names the order in the subject, or its id without a display id", () => {
    expect(cancelTooLateSubject(data)).toBe("Order #42 was cancelled but has already shipped")
    expect(cancelTooLateSubject({ order: { id: "order_01", display_id: null } })).toBe("Order order_01 was cancelled but has already shipped")
    expect(cancelTooLateContent({ order: { id: "order_01" } }).subject).toBe("Order order_01 was cancelled but has already shipped")
  })

  it("lists the reason, fulfilments, tracking and links", () => {
    const { html, text } = cancelTooLateContent(data)
    expect(html).toContain("some parcels shipped and some failed")
    expect(html).toContain('<a href="https://app.printtrail.com/orders/ORD-42">ORD-42</a>')
    expect(html).toContain('<a href="https://track.example/RM123">RM123</a> (Royal Mail)')
    expect(html).toContain("F2: failed (no tracking)")
    expect(html).toContain('href="https://shop.example.com/app/orders/order_01"')
    expect(html).toContain("Contact the customer, then refund the order or arrange a return")
    expect(text).toContain("Print Trail order: ORD-42 (https://app.printtrail.com/orders/ORD-42)")
    expect(text).toContain("RM123 (https://track.example/RM123) (Royal Mail)")
    expect(text).toContain("F2: failed (no tracking)")
    expect(text).toContain("Order in Medusa admin: https://shop.example.com/app/orders/order_01")
    expect(text).toContain("Contact the customer")
    expect(text).not.toMatch(/<[a-z]/i)
  })

  it.each([
    ["dispatched", "Some or all of it has shipped."],
    ["complete", "Print Trail has finished it."],
    ["partial", "Print Trail has finished it: some parcels shipped and some failed."],
    ["something-new", "Print Trail had already dispatched some or all of it."],
  ])("why %s has its sentence", (why, sentence) => {
    const { html, text } = cancelTooLateContent({ ...data, why })
    expect(html).toContain(escapeHtml(sentence))
    expect(text).toContain(sentence)
  })

  it("leaves out missing and unsafe links and escapes values", () => {
    const { html, text } = cancelTooLateContent({
      ...data,
      pt_url: null,
      admin_order_url: "javascript:alert(1)",
      print_trail_order_number: "<b>x</b>",
      fulfilments: [{ number: "F1", status: "dispatched", tracking: [{ number: "T<1>", url: "mailto:x@y", carrier: "<i>c</i>" }] }],
    })
    expect(html).not.toContain("javascript:")
    expect(html).not.toContain("mailto:")
    expect(html).not.toContain("Order in Print Trail")
    expect(html).not.toContain("Order in Medusa admin")
    expect(html).toContain("&#60;b&#62;x&#60;/b&#62;")
    expect(html).toContain("T&#60;1&#62; (&#60;i&#62;c&#60;/i&#62;)")
    expect(text).not.toContain("javascript:")
    expect(text).not.toContain("mailto:")
  })

  it("escapes values in attributes", () => {
    const { html } = cancelTooLateContent({ ...data, pt_url: 'https://x.example/"onmouseover="alert(1)', print_trail_order_number: "ORD'42" })
    expect(html).toContain('href="https://x.example/&#34;onmouseover=&#34;alert(1)"')
    expect(html).not.toContain('"onmouseover="')
    expect(html).toContain("ORD&#39;42")
  })
})

describe("escaping and links", () => {
  it("escapes the five characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe("&#60;a href=&#34;x&#34; title=&#39;y&#39;&#62;&#38;&#60;/a&#62;")
    expect(escapeHtml(null)).toBe("")
  })

  it.each(["javascript:alert(1)", "mailto:a@b", "//evil.example", "/relative", "ftp://x", "https://", " https://x", "https://x\nBcc: a", 7])(
    "%p is not an http link",
    (v) => expect(isHttpUrl(v)).toBe(false)
  )

  it("http and https are links", () => {
    expect(isHttpUrl("https://x.example/a")).toBe(true)
    expect(isHttpUrl("HTTP://x.example")).toBe(true)
  })
})

describe("print-trail-shipment email", () => {
  const ship = {
    order: { id: "order_1", display_id: 1001 },
    print_trail_order_number: "ORD-1001",
    carrier: "Royal Mail",
    items: [{ line_item_id: "item_a", title: "Book & Co", quantity: 2 }],
    tracking: [
      { number: "T2", url: "https://rm.example/T2" },
      { number: "T1", url: "javascript:alert(1)" },
    ],
  }

  it("lists the order, carrier, items and tracking", () => {
    const { subject, html, text } = shipmentContent(ship)
    expect(subject).toBe("Your order #1001 is on its way")
    expect(html).toContain("A parcel from your order #1001 has been dispatched by Royal Mail.")
    expect(html).toContain("2 × Book &#38; Co")
    expect(html).toContain('<a href="https://rm.example/T2">T2</a>')
    expect(html).toContain("<li>T1</li>")
    expect(html).not.toContain("javascript:")
    expect(html).not.toContain("ORD-1001")
    expect(text).toContain("- 2 × Book & Co")
    expect(text).toContain("- T2 (https://rm.example/T2)")
    expect(text).toMatch(/^- T1$/m)
    expect(text).not.toContain("javascript:")
  })

  it("shows a missing or nonsense quantity as 1", () => {
    for (const quantity of [Number.NaN, null, undefined, "x", -2, Infinity]) {
      const { html, text } = shipmentContent({ order: { id: "o" }, items: [{ title: "Book", quantity: quantity as never }] })
      expect(html).toContain("1 × Book")
      expect(text).toContain("- 1 × Book")
    }
  })

  it("words a parcel that waited for its pre-order release as the pre-order", () => {
    const { subject, html, text } = shipmentContent({ ...ship, pre_order: true })
    expect(subject).toBe("Your pre-order from order #1001 has shipped")
    expect(html).toContain("<h2>Your pre-order from order #1001 is on its way</h2>")
    expect(html).toContain("Your pre-order from order #1001 has been released and dispatched by Royal Mail.")
    expect(html).toContain('<a href="https://rm.example/T2">T2</a>')
    expect(text.split("\n").slice(0, 3)).toEqual([
      "Your pre-order from order #1001 is on its way",
      "",
      "Your pre-order from order #1001 has been released and dispatched by Royal Mail.",
    ])
    expect(text).toContain("- 2 × Book & Co")
    // Only true counts.
    expect(shipmentContent({ ...ship, pre_order: "yes" as never }).subject).toBe("Your order #1001 is on its way")
    expect(shipmentContent({ ...ship, pre_order: false }).html).toContain("A parcel from your order #1001 has been dispatched by Royal Mail.")
  })

  it("falls back to the order id and leaves out a missing carrier", () => {
    const { subject, html } = shipmentContent({ order: { id: "order_1" }, tracking: [{ number: "T1", url: null }] })
    expect(subject).toBe("Your order order_1 is on its way")
    expect(html).toContain("has been dispatched.")
  })
})
