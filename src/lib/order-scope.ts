import { createHash } from "node:crypto"
import type { GraphOrder, ScopedLine, SelectedLine } from "./lines"
import { PRINT_TRAIL_PROVIDER_ID } from "./lines"

// Which Medusa lines each print_trail_order row carries. Sequence 1 is the
// order itself; claims, exchanges, released lines (remainders) and reissues
// of a row Print Trail cancelled get rows of their own, numbered "-n".

export type ScopeRow = {
  id: string
  sequence: number
  source_ref?: string | null
  pt_uuid?: string | null
  status?: string | null
  confirmed_at?: Date | string | null
  cancel_status?: string | null
  submitted_lines?: unknown
}

export type SourceRef =
  | { kind: "base" }
  | { kind: "claim" | "exchange"; id: string }
  | { kind: "remainder"; sequence: number }
  | { kind: "reissue"; of: number }

export function parseSourceRef(ref: string | null | undefined): SourceRef {
  const m = ref?.match(/^(claim|exchange|remainder|reissue):(.*)$/)
  if (!m) return { kind: "base" }
  if (m[1] === "claim" || m[1] === "exchange") return { kind: m[1], id: m[2] }
  const n = Number(m[2])
  return m[1] === "remainder" ? { kind: "remainder", sequence: n } : { kind: "reissue", of: n }
}

export function formatSourceRef(s: SourceRef): string | null {
  switch (s.kind) {
    case "base":
      return null
    case "claim":
    case "exchange":
      return `${s.kind}:${s.id}`
    case "remainder":
      return `remainder:${s.sequence}`
    case "reissue":
      return `reissue:${s.of}`
  }
}

export type SendTarget =
  | { ok: true; sequence: number; sourceRef: string | null; rowId: string | null }
  | { ok: false; reason: "reissue-not-allowed" | "unknown-sequence"; detail: string }

const maxSequence = (rows: ScopeRow[]) => rows.reduce((m, r) => Math.max(m, r.sequence), 0)

// Print Trail cancelled it (not Medusa: a Medusa cancel sets cancel_status).
const cancelledAtPrintTrail = (r: ScopeRow) => r.status === "cancelled" && !r.cancel_status

export function resolveSendTarget(
  rows: ScopeRow[],
  input: { sequence?: number; source_ref?: string; reissue_of?: number }
): SendTarget {
  const bySeq = (n: number) => rows.find((r) => r.sequence === n)
  const byRef = (ref: string) => rows.find((r) => r.source_ref === ref)
  const existing = (r: ScopeRow): SendTarget => ({ ok: true, sequence: r.sequence, sourceRef: r.source_ref ?? null, rowId: r.id })
  const fresh = (sequence: number, sourceRef: string | null): SendTarget => ({ ok: true, sequence, sourceRef, rowId: null })

  if (input.reissue_of !== undefined) {
    const n = input.reissue_of
    const original = bySeq(n)
    if (!original || !cancelledAtPrintTrail(original)) {
      const state = !original
        ? "doesn't exist"
        : original.cancel_status
          ? `was cancelled from Medusa (${original.cancel_status})`
          : `is ${original.status ?? "not sent"}`
      return {
        ok: false,
        reason: "reissue-not-allowed",
        detail: `Only an order Print Trail cancelled can be sent again as a new order; Print Trail order ${n} ${state}`,
      }
    }
    const ref = `reissue:${n}`
    const reissue = byRef(ref)
    return reissue ? existing(reissue) : fresh(Math.max(2, maxSequence(rows) + 1), ref)
  }

  if (input.source_ref) {
    const r = byRef(input.source_ref)
    return r ? existing(r) : fresh(Math.max(2, maxSequence(rows) + 1), input.source_ref)
  }

  if (input.sequence !== undefined) {
    const r = bySeq(input.sequence)
    if (r) return existing(r)
    if (input.sequence === 1) return fresh(1, null)
    return { ok: false, reason: "unknown-sequence", detail: `This order has no Print Trail order ${input.sequence}` }
  }

  // Auto: the order itself until Print Trail has it confirmed or cancelled,
  // then whatever no row has sent yet.
  const first = bySeq(1)
  if (!first || (!first.confirmed_at && first.status !== "cancelled" && !first.cancel_status)) {
    return first ? existing(first) : fresh(1, null)
  }
  const unposted = rows.find((r) => parseSourceRef(r.source_ref).kind === "remainder" && !r.pt_uuid && !r.cancel_status)
  if (unposted) return existing(unposted)
  const sequence = maxSequence(rows) + 1
  return fresh(sequence, `remainder:${sequence}`)
}

// lineNumber → quantity the row sent.
export function submittedQuantities(row: Pick<ScopeRow, "submitted_lines">): Map<string, number> {
  const out = new Map<string, number>()
  const lines = Array.isArray(row.submitted_lines) ? row.submitted_lines : []
  for (const l of lines as { lineNumber?: unknown; quantity?: unknown }[]) {
    if (typeof l?.lineNumber !== "string") continue
    const q = Number(l.quantity ?? 0)
    if (q > 0) out.set(l.lineNumber, (out.get(l.lineNumber) ?? 0) + q)
  }
  return out
}

// A row cancelled from Medusa (an emptied draft's cancel) or never sent
// gives its lines up: re-added lines go out as a new "-n" order.
export const releasesLines = (r: Pick<ScopeRow, "cancel_status">) =>
  r.cancel_status === "cancelled" || r.cancel_status === "not-sent"

// What the order's rows have sent, by lineNumber. A row cancelled at Print
// Trail still owns its lines until a reissue row replaces it.
export function ownedQuantities(rows: ScopeRow[], exceptRowId?: string | null): Map<string, number> {
  const reissued = new Set(
    rows.flatMap((r) => {
      const ref = parseSourceRef(r.source_ref)
      return ref.kind === "reissue" ? [ref.of] : []
    })
  )
  const out = new Map<string, number>()
  for (const r of rows) {
    if (r.id === exceptRowId || reissued.has(r.sequence) || releasesLines(r)) continue
    for (const [k, q] of submittedQuantities(r)) out.set(k, (out.get(k) ?? 0) + q)
  }
  return out
}

const plain = ({ replacementOf: _r, ...line }: ScopedLine): SelectedLine => line

export function scopedLines(
  lines: ScopedLine[],
  rows: ScopeRow[],
  target: Extract<SendTarget, { ok: true }>
): SelectedLine[] {
  const ref = parseSourceRef(target.sourceRef)
  switch (ref.kind) {
    case "base":
      return lines.filter((l) => !l.replacementOf).map(plain)
    case "claim":
    case "exchange":
      return lines.filter((l) => l.replacementOf === target.sourceRef).map(plain)
    case "remainder": {
      const owned = ownedQuantities(rows, target.rowId)
      return lines.flatMap((l) => {
        if (l.replacementOf) return []
        const quantity = l.quantity - (owned.get(l.lineItemId) ?? 0)
        return quantity > 0 ? [{ ...plain(l), quantity }] : []
      })
    }
    case "reissue": {
      const original = rows.find((r) => r.sequence === ref.of)
      const byId = new Map(lines.map((l) => [l.lineItemId, l]))
      return [...submittedQuantities(original ?? {}).keys()].flatMap((lineNumber) => {
        const l = byId.get(lineNumber)
        return l && l.quantity > 0 ? [plain(l)] : []
      })
    }
  }
}

// Items in a Print Trail shipping profile that no Print Trail shipping method
// on the order serves, so they'd never be sent (an edit added them to an
// order shipped by another provider). Sorted item ids.
export function unservedPrintTrailItems(order: GraphOrder, ptProfileIds: string[]): string[] {
  const profiles = new Set(ptProfileIds)
  const served = new Set<string>()
  for (const sm of order.shipping_methods ?? []) {
    const option = sm?.shipping_option
    if (option?.provider_id === PRINT_TRAIL_PROVIDER_ID && option.shipping_profile_id) {
      served.add(option.shipping_profile_id)
    }
  }
  return (order.items ?? [])
    .flatMap((item) => {
      const profile = item?.variant?.product?.shipping_profile?.id
      const quantity = Number(item?.detail?.quantity ?? 0)
      return item && profile && profiles.has(profile) && !served.has(profile) && quantity > 0 ? [item.id] : []
    })
    .sort()
}

const IGNORED_KEYS = new Set(["email", "phone", "note"])

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .filter((k) => !IGNORED_KEYS.has(k) && (value as Record<string, unknown>)[k] !== undefined)
        .sort()
        .map((k) => [k, stable((value as Record<string, unknown>)[k])])
    )
  }
  return value
}

// A fingerprint of the delivery address, without contact details or the
// note, so an email or phone change isn't an address change.
export function addressFingerprint(details: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(details) ?? null)).digest("hex")
}
