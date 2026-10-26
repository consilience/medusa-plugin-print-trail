import { PrintTrailApiError, PROBLEM_TYPES, type AccessRefusal } from "../modules/printTrail/client/errors"
import type { PtOrder } from "../modules/printTrail/client/types"

export type CreateDecision = "skip-confirmed" | "adopt-confirmed" | "remote-cancelled" | "post" | "conflict"

// Print Trail's own test for a confirmed order, without confirmedAt: what
// Print Trail still counts as confirmed for an order confirmed before
// confirmedAt existed (an unbackfilled one reads null).
const legacyConfirmed = (remote: PtOrder) =>
  remote.status === "queued" || remote.status === "scheduled" || remote.status === "processing" || !!remote.fulfillableFrom

// What the create step does, given the local row and the order as Print
// Trail has it now (fetched by the row's pt_uuid, from a create 409's data,
// or found by number after one). Never re-posts a confirmed order: a re-post
// used to turn it back into a draft.
//
// Each Print Trail signal is used when present, in this order: the typed 409
// (problemType, API 1.1.0), confirmedAt (API 1.1.0), then the status
// heuristics that are all an older Print Trail API gives.
export function decideCreate(
  row: { pt_uuid?: string | null; confirmed_at?: Date | string | null } | null,
  remote: PtOrder | null,
  opts: { conflict?: boolean; problemType?: string | null } = {}
): CreateDecision {
  if (row?.confirmed_at) {
    return "skip-confirmed"
  }
  if (!remote) {
    return "post"
  }
  if (remote.status === "cancelled") {
    return "remote-cancelled"
  }
  if (opts.problemType === PROBLEM_TYPES.alreadyConfirmed) {
    return "adopt-confirmed"
  }
  // Since API 1.1.1 a finished order (complete, failed, returned, partial;
  // cancelled is handled above) answers "not updatable" even if it was once
  // confirmed, so the type no longer says which: the order does. A confirmed one
  // (confirmedAt, or Print Trail's legacy signals for one confirmed before
  // confirmedAt existed) is ours: adopt it, and the sync records its final state.
  // One never confirmed is a real conflict (the row records the order). Under
  // 1.1.0 a once-confirmed order was "already confirmed" whatever its status.
  if (opts.problemType === PROBLEM_TYPES.notUpdatable) {
    return typeof remote.confirmedAt === "string" || legacyConfirmed(remote) ? "adopt-confirmed" : "conflict"
  }
  if (typeof remote.confirmedAt === "string") {
    return "adopt-confirmed"
  }
  // confirmedAt null: confirmed only by Print Trail's legacy signals (→ adopt).
  // Otherwise post, and let Print Trail decide: it replaces what it can (a
  // draft, a never-confirmed hold, an invalid or error order with nothing under
  // way) and answers the rest with a typed 409, which blocks (the path above).
  // After an untyped 409, it is a conflict.
  if (remote.confirmedAt === null) {
    if (legacyConfirmed(remote)) return "adopt-confirmed"
    return opts.conflict ? "conflict" : "post"
  }
  // No confirmedAt key (an older Print Trail API), or null without a conflict.
  // After a create 409, adopt only what reads as past confirmation. A plain
  // draft would be stranded unshipped if recorded as confirmed: block it.
  if (opts.conflict) {
    return remote.status !== "draft" || remote.fulfillableFrom ? "adopt-confirmed" : "conflict"
  }
  // fulfillableFrom is set while a confirmed order waits (e.g. holding for
  // stock). Create replaces a draft or a never-confirmed holding order (its
  // address was rejected); any other status is past confirmation.
  const replaceable = remote.status === "draft" || remote.status === "holding"
  if (!replaceable || remote.fulfillableFrom) {
    return "adopt-confirmed"
  }
  return "post"
}

const dateOf = (iso: string | null | undefined): Date | null => {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

// When an adopted order was confirmed: Print Trail's confirmedAt, else its
// countdown, else now.
export function confirmedAtOf(remote: PtOrder, now: Date): Date {
  return dateOf(remote.confirmedAt) ?? dateOf(remote.fulfillableFrom) ?? now
}

export type ConfirmFailure =
  | { kind: "stock"; shortfall: { sku: string; requested: number; available: number }[] }
  | { kind: "shipping-conflict"; order: PtOrder }
  | { kind: "not-confirmable"; detail: string }
  | { kind: "invalid"; detail: string }
  | { kind: "transient"; detail: string }
  | { kind: AccessRefusal }
  // Another 403: an inactive team (API 1.2.0) or a Standard-channel token.
  | { kind: "rejected-403"; detail: string }

export function interpretConfirmError(err: PrintTrailApiError): ConfirmFailure {
  if (err.isTransient) {
    return { kind: "transient", detail: err.detail }
  }
  const refusal = err.accessRefusal
  if (refusal) {
    return { kind: refusal }
  }
  if (err.status === 403) {
    return { kind: "rejected-403", detail: err.detail }
  }
  const shortfall = err.stockShortfall
  if (shortfall) {
    return { kind: "stock", shortfall }
  }
  const order = err.shippingConflictOrder
  if (order) {
    return { kind: "shipping-conflict", order }
  }
  if (err.status === 428) {
    return { kind: "not-confirmable", detail: err.detail }
  }
  return { kind: "invalid", detail: err.detail }
}
