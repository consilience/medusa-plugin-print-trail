import { PrintTrailApiError, type AccessRefusal } from "../modules/printTrail/client/errors"
import type { PtLinesRequest, PtOrder } from "../modules/printTrail/client/types"
import type { ScopedLine } from "./lines"
import { ownedQuantities, releasesLines, submittedQuantities, type ScopeRow } from "./order-scope"

// What a confirmed Medusa order edit means for each print_trail_order row.
// Pure.

export type AmendLine = { lineNumber: string; quantity: number; sku: string | null; added: boolean }

// The lines the row should carry now: each line it sent, at the order's
// current quantity less what other rows carry (0 when the item is gone),
// and, on sequence 1 only, base lines no row has sent at all.
// itemQuantities: the order's items (items.detail.quantity). A sent line
// missing from `lines` whose item is still on the order was held back by
// filterLines, not removed: it keeps what was sent. Without the map, a
// missing line counts as removed.
export function desiredLines(
  row: ScopeRow,
  rows: ScopeRow[],
  lines: ScopedLine[],
  itemQuantities?: Map<string, number>
): AmendLine[] {
  const byId = new Map(lines.map((l) => [l.lineItemId, l]))
  const others = ownedQuantities(rows, row.id)
  const submitted = submittedQuantities(row)
  const submittedSku = new Map(
    (Array.isArray(row.submitted_lines) ? (row.submitted_lines as { lineNumber?: string; product?: { sku?: string } }[]) : []).map(
      (l) => [String(l.lineNumber), l.product?.sku ?? null]
    )
  )
  const out: AmendLine[] = []
  for (const [lineNumber, sent] of submitted) {
    const l = byId.get(lineNumber)
    if (!l && itemQuantities && (itemQuantities.get(lineNumber) ?? 0) > 0) {
      out.push({ lineNumber, quantity: sent, sku: submittedSku.get(lineNumber) ?? null, added: false })
      continue
    }
    const quantity = Math.max(0, (l?.quantity ?? 0) - (others.get(lineNumber) ?? 0))
    out.push({ lineNumber, quantity, sku: l?.sku ?? null, added: false })
  }
  if (row.sequence === 1) {
    const sentAnywhere = ownedQuantities(rows)
    for (const l of lines) {
      if (l.replacementOf || sentAnywhere.has(l.lineItemId) || out.some((o) => o.lineNumber === l.lineItemId)) continue
      if (l.quantity > 0) out.push({ lineNumber: l.lineItemId, quantity: l.quantity, sku: l.sku, added: true })
    }
  }
  return out
}

export type AmendAction =
  | { kind: "none" }
  | { kind: "resend" }
  | { kind: "cancel-emptied" }
  | { kind: "put-lines"; body: PtLinesRequest; added: string[] }
  | { kind: "closed"; why: "pt-cancelled" | "cancelled-here"; reAdded: string[] }

const nonZero = (lines: AmendLine[]) => lines.filter((l) => l.quantity > 0)

function sameLines(desired: AmendLine[], submitted: Map<string, number>) {
  const want = nonZero(desired)
  return want.length === submitted.size && want.every((l) => submitted.get(l.lineNumber) === l.quantity)
}

export function planAmend(
  row: ScopeRow,
  rows: ScopeRow[],
  lines: ScopedLine[],
  orderCanceled: boolean,
  itemQuantities?: Map<string, number>
): AmendAction {
  // The cancel flow owns a Medusa-cancelled order.
  if (orderCanceled) return { kind: "none" }
  const desired = desiredLines(row, rows, lines, itemQuantities)
  const submitted = submittedQuantities(row)
  // Lines asked for (or raised) on an order that can't be reopened.
  // A row that gave its lines up (cancelled from Medusa) re-adds every line
  // asked for; any other closed row only what's above what it sent.
  const reAdded = () =>
    nonZero(desired)
      .filter((l) => releasesLines(row) || l.quantity > (submitted.get(l.lineNumber) ?? 0))
      .map((l) => l.lineNumber)
  if (row.cancel_status) return { kind: "closed", why: "cancelled-here", reAdded: reAdded() }
  if (row.status === "cancelled") return { kind: "closed", why: "pt-cancelled", reAdded: reAdded() }
  if (sameLines(desired, submitted)) return { kind: "none" }
  const empty = nonZero(desired).length === 0
  if (!row.confirmed_at) {
    return empty && row.pt_uuid ? { kind: "cancel-emptied" } : { kind: "resend" }
  }
  if (empty) return { kind: "cancel-emptied" }
  return {
    kind: "put-lines",
    body: {
      orderLines: desired.map((l) => ({
        lineNumber: l.lineNumber,
        quantity: l.quantity,
        ...(l.added && l.sku ? { product: { sku: l.sku } } : {}),
      })),
    },
    added: desired.filter((l) => l.added).map((l) => l.lineNumber),
  }
}

const ptQuantities = (pt: Pick<PtOrder, "orderLines">) => {
  const out = new Map<string, number>()
  for (const l of pt.orderLines ?? []) {
    const key = String(l.lineNumber)
    out.set(key, (out.get(key) ?? 0) + Number(l.quantity ?? 0))
  }
  return out
}

const sameMaps = (a: Map<string, number>, b: Map<string, number>) =>
  a.size === b.size && [...a].every(([k, v]) => b.get(k) === v)

// Print Trail's lines (split lines summed) differ from what the plugin sent.
export function ptLinesDiverged(submitted: unknown, pt: Pick<PtOrder, "orderLines">): boolean {
  return !sameMaps(submittedQuantities({ submitted_lines: submitted }), ptQuantities(pt))
}

// Print Trail already carries these lines (a PUT whose recording died).
export function ptHasLines(lines: { lineNumber: string; quantity: number }[], pt: Pick<PtOrder, "orderLines">): boolean {
  const want = new Map(lines.filter((l) => l.quantity > 0).map((l) => [l.lineNumber, l.quantity]))
  return sameMaps(want, ptQuantities(pt))
}

export type AmendFailure =
  | { kind: "retry"; detail: string }
  | { kind: "no-lines" }
  | { kind: "not-found" }
  | { kind: AccessRefusal }
  // shortfall: a stock-held refusal's errors[] (the pre-order limit, or stock
  // held by other orders), as on a confirm.
  | { kind: "refused"; detail: string; reason: string | null; shortfall?: { sku: string; requested: number; available: number }[] }

const RETRY_REASONS = new Set(["being-rebuilt", "unexpected-error"])

export function interpretAmendError(e: PrintTrailApiError): AmendFailure {
  const body = (e.body && typeof e.body === "object" ? e.body : {}) as Record<string, unknown>
  const reason = typeof body.reason === "string" ? body.reason : null
  if (e.isTransient || (reason && RETRY_REASONS.has(reason))) return { kind: "retry", detail: e.detail }
  if (reason === "no-lines") return { kind: "no-lines" }
  if (e.status === 404 || reason === "order-not-found") return { kind: "not-found" }
  const refusal = e.accessRefusal
  if (refusal) return { kind: refusal }
  const merchant = typeof body.merchantMessage === "string" && body.merchantMessage ? body.merchantMessage : null
  const shortfall = reason === "stock-held" ? e.stockShortfall : null
  return { kind: "refused", detail: merchant ?? e.detail, reason, ...(shortfall?.length ? { shortfall } : {}) }
}
