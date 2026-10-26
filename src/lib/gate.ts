import type { PtConfirmRequest, PtOrder } from "../modules/printTrail/client/types"

export type GateInput = {
  confirmedAt: Date | string | null
  canceled: boolean
  captured: number
  refunded: number
  confirmOn: "order.placed" | "payment.captured"
  blockReason: string | null
  pt: PtOrder
  sentLineNumbers: string[]
}

export type GateResult = { ok: true } | { ok: false; reason: string; detail?: string }

// The single place the confirm decision is made, on the order as it is now
// (a retry never confirms an order since cancelled or refunded). Checks run
// in a fixed order: already confirmed first, then each reason to hold back.
export function evaluateGate(input: GateInput): GateResult {
  if (input.confirmedAt) {
    // Print Trail's status can't tell: holding occurs before and after confirm.
    return { ok: false, reason: "already-confirmed" }
  }
  if (input.canceled) {
    return { ok: false, reason: "order-canceled" }
  }
  if (input.captured > 0 && input.refunded >= input.captured) {
    return { ok: false, reason: "fully-refunded" }
  }
  if (input.confirmOn === "payment.captured" && !(input.captured > 0)) {
    return { ok: false, reason: "awaiting-payment" }
  }
  if (input.blockReason) {
    return { ok: false, reason: `blocked:${input.blockReason}` }
  }
  if (input.pt.fulfillableStatus !== "fulfillable") {
    return {
      ok: false,
      reason: "not-fulfillable",
      detail: `Print Trail reports the order as ${input.pt.fulfillableStatus ?? "unknown"}`,
    }
  }
  const errors = input.pt.errors ?? []
  if (errors.length) {
    return {
      ok: false,
      reason: "pt-errors",
      detail: errors.map((e) => e.message ?? e.key ?? e.code).join("; "),
    }
  }
  const returned = new Set((input.pt.orderLines ?? []).map((l) => l.lineNumber))
  const missing = input.sentLineNumbers.filter((n) => !returned.has(n))
  if (missing.length) {
    return {
      ok: false,
      reason: "missing-lines",
      detail: `Lines not accepted by Print Trail: ${missing.join(", ")}`,
    }
  }
  return { ok: true }
}

export type ConfirmBodyResult =
  // notes: fulfilments shipping below a method one of their lines was bought
  // with, for the timeline. Present only when there are some.
  | { ok: true; body: PtConfirmRequest; notes?: string[] }
  | { ok: false; reason: "shipping-method-unavailable"; detail: string }

// Best first. Codes not listed rank below standard.
const METHOD_RANK = ["express", "tracked", "air", "standard"]
const rankOf = (code: string) => {
  const i = METHOD_RANK.indexOf(code)
  return i === -1 ? METHOD_RANK.length : i
}

// The method for one fulfilment. Print Trail can put lines bought with
// different methods in one fulfilment: then the best of them that the
// fulfilment offers wins. With no offer list, the best of them; with none of
// them offered, the first line's, which the caller then blocks.
function methodForFulfilment(wanted: string[], available: string[], defaultMethod: string): string {
  const distinct = [...new Set(wanted)]
  if (distinct.length <= 1) {
    return distinct[0] ?? defaultMethod
  }
  const ranked = [...distinct].sort((a, b) => rankOf(a) - rankOf(b))
  if (!available.length) {
    return ranked[0]
  }
  return ranked.find((m) => available.includes(m)) ?? distinct[0]
}

// Each fulfilment ships by the method its lines were bought with, and only by
// a code that fulfilment offers. A fulfilment whose lines share one method
// blocks when that code is unavailable rather than downgrading; a merged
// fulfilment ships by the best of its lines' methods that it offers, with a
// note when that is below the best its lines were bought with.
export function buildConfirmBody(
  pt: PtOrder,
  methodByLine: Map<string, string>,
  defaultMethod: string
): ConfirmBodyResult {
  const fulfilmentShippingMethods: { fulfilmentUuid: string; shippingMethod: string }[] = []
  const notes: string[] = []
  for (const f of pt.fulfilments ?? []) {
    const lineMethods = (f.orderLines ?? [])
      .map((l) => (l.lineNumber ? methodByLine.get(l.lineNumber) : undefined))
      .filter((m): m is string => !!m)
    const available = (f.availableShippingMethods ?? []).map((m) => m.code).filter((c): c is string => !!c)
    const wanted = methodForFulfilment(lineMethods, available, defaultMethod)
    if (available.length && !available.includes(wanted)) {
      return {
        ok: false,
        reason: "shipping-method-unavailable",
        detail: `Fulfilment ${f.fulfilmentNumber ?? f.uuid} can't ship by "${wanted}" (available: ${available.join(", ")})`,
      }
    }
    const best = [...lineMethods].sort((a, b) => rankOf(a) - rankOf(b))[0]
    if (best && rankOf(wanted) > rankOf(best)) {
      notes.push(`Fulfilment ${f.fulfilmentNumber ?? f.uuid} ships ${wanted}; ${best} isn't offered for it`)
    }
    fulfilmentShippingMethods.push({ fulfilmentUuid: f.uuid, shippingMethod: wanted })
  }
  const body = { defaultShippingMethod: defaultMethod, fulfilmentShippingMethods }
  return notes.length ? { ok: true, body, notes } : { ok: true, body }
}
