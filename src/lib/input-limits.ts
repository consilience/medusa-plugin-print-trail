// API 1.2.0's request limits, and the schema's whole-number quantities, each
// a 422 naming the field: checked before a request is sent, so an order that
// can never be accepted is blocked with a reason instead of posted, refused
// and left for someone to puzzle over. (A 422 that gets through anyway is a
// refusal too, never retried.)
export const PT_LIMITS = {
  orderNumber: 255,
  printTrailOrderNumber: 255,
  sku: 255,
  orderLines: 500,
} as const

export const OVER_LIMITS = "over-limits"

type Line = { lineNumber?: string; quantity?: unknown; product?: { sku?: string | null } | null }

// Characters (code points), as Print Trail counts them for its length limits,
// not UTF-16 code units.
export const charCount = (s: string) => [...s].length
const tooLong = (v: unknown, max: number) => typeof v === "string" && charCount(v) > max

// A quantity Print Trail takes: a whole number (the schema's integer).
// Medusa's are numbers, which can be fractional (a cart accepts any
// quantity above 0, and inventory can be fractional from 2.20), so one is
// never rounded into a different order.
const wholeQuantity = (q: unknown) => q === undefined || (typeof q === "number" && Number.isInteger(q) && q >= 0)

const onLines = (lines: Line[]) => `line${lines.length > 1 ? "s" : ""} ${lines.map((l) => l.lineNumber ?? "?").join(", ")}`

// What's over a limit, in words. Only lines with a product carry a
// SKU (an amend's removed lines may not).
export function linesOverLimits(lines: Line[]): string[] {
  const out: string[] = []
  if (lines.length > PT_LIMITS.orderLines) {
    out.push(`${lines.length} order lines (Print Trail accepts at most ${PT_LIMITS.orderLines})`)
  }
  const long = lines.filter((l) => tooLong(l.product?.sku, PT_LIMITS.sku))
  if (long.length) {
    out.push(`a SKU longer than ${PT_LIMITS.sku} characters on ${onLines(long)}`)
  }
  const fractional = lines.filter((l) => !wholeQuantity(l.quantity))
  if (fractional.length) {
    out.push(`a quantity that isn't a whole number on ${onLines(fractional)}`)
  }
  return out
}

export function orderOverLimits(payload: {
  orderNumber?: string
  printTrailOrderNumber?: string
  orderLines: Line[]
}): string | null {
  const out: string[] = []
  if (tooLong(payload.orderNumber, PT_LIMITS.orderNumber)) {
    out.push(`an order number longer than ${PT_LIMITS.orderNumber} characters`)
  }
  if (tooLong(payload.printTrailOrderNumber, PT_LIMITS.printTrailOrderNumber)) {
    out.push(`a printTrailOrderNumber longer than ${PT_LIMITS.printTrailOrderNumber} characters`)
  }
  out.push(...linesOverLimits(payload.orderLines))
  return out.length ? `Over Print Trail's limits: ${out.join("; ")}` : null
}
