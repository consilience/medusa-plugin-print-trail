import { linesOverLimits, orderOverLimits, PT_LIMITS } from "../input-limits"

const line = (n: number, sku = `SKU-${n}`) => ({ lineNumber: String(n), quantity: 1, product: { sku } })
const lines = (count: number) => Array.from({ length: count }, (_, i) => line(i + 1))

describe("API 1.2.0 input limits", () => {
  it("accepts an order at the limits", () => {
    expect(
      orderOverLimits({
        orderNumber: "A".repeat(255),
        printTrailOrderNumber: "B".repeat(255),
        orderLines: [...lines(499), line(500, "S".repeat(255))],
      })
    ).toBeNull()
  })

  it("names everything over them", () => {
    const detail = orderOverLimits({
      orderNumber: "A".repeat(256),
      printTrailOrderNumber: "B".repeat(256),
      orderLines: [...lines(499), line(500, "S".repeat(256)), line(501, "T".repeat(300))],
    })
    expect(detail).toBe(
      "Over Print Trail's limits: an order number longer than 255 characters; " +
        "a printTrailOrderNumber longer than 255 characters; " +
        "501 order lines (Print Trail accepts at most 500); " +
        "a SKU longer than 255 characters on lines 500, 501"
    )
  })

  it("counts characters (code points), as Print Trail's length limits do", () => {
    // Each of these is two UTF-16 code units and one character.
    expect(orderOverLimits({ orderNumber: "📚".repeat(255), orderLines: [line(1, "é📚".repeat(127))] })).toBeNull()
    expect(orderOverLimits({ orderNumber: "📚".repeat(256), orderLines: [] })).toContain("order number longer than 255")
  })

  it("names a quantity that isn't a whole number, which Print Trail refuses", () => {
    const at = (n: number, quantity: unknown) => ({ ...line(n), quantity })
    expect(orderOverLimits({ orderLines: [line(1), at(2, 1.5), at(3, 0.5), at(4, 2)] })).toBe(
      "Over Print Trail's limits: a quantity that isn't a whole number on lines 2, 3"
    )
    // An amend's removed line is 0; a line with no quantity isn't checked.
    expect(linesOverLimits([at(1, 0), { lineNumber: "2" }])).toEqual([])
    expect(linesOverLimits([at(1, -1), at(2, Number.NaN), at(3, "2")])).toEqual(["a quantity that isn't a whole number on lines 1, 2, 3"])
  })

  it("checks an amend's lines, which may carry no product", () => {
    expect(linesOverLimits([{ lineNumber: "1" }, line(2)])).toEqual([])
    expect(linesOverLimits([line(1, "S".repeat(PT_LIMITS.sku + 1))])).toEqual([
      "a SKU longer than 255 characters on line 1",
    ])
  })
})
