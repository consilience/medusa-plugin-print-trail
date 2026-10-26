import type { PtStockLevel } from "../modules/printTrail/client/types"
import type { SkuCheck, SkuCheckStatus } from "./sku-check"
import { normaliseSku } from "./sku"

// A variant's SKU check lives in the plugin's print_trail_variant table, one
// row per checked variant. Before 1.0.0 it was kept in the variant's metadata
// under LEGACY_SKU_CHECK_KEY; until a variant has a row, that legacy check is
// still read, so an upgrade shows no blank badge. The metadata scan copies
// each legacy check into a row and then deletes the key.

export type CheckSource = "sku-check" | "stock-sync" | "metadata"

export type VariantCheckRow = {
  id: string
  variant_id: string
  product_id: string
  check_sku: string | null
  check_status: string | null
  check_matched_sku: string | null
  check_note: string | null
  checked_at: Date | string | null
  check_source: string | null
  // Set by the database layer on every row it reads in full.
  created_at?: Date | string | null
  updated_at?: Date | string | null
}

export type CheckColumns = Pick<
  VariantCheckRow,
  "check_sku" | "check_status" | "check_matched_sku" | "check_note" | "check_source"
> & { checked_at: Date | null }

export const LEGACY_SKU_CHECK_KEY = "print_trail_sku_check"

const STATUSES: readonly SkuCheckStatus[] = ["matched", "inactive", "pre-order", "not-found", "no-sku", "error"]

export const isSkuCheckStatus = (s: unknown): s is SkuCheckStatus =>
  typeof s === "string" && (STATUSES as readonly string[]).includes(s)

const iso = (at: Date | string | null | undefined): string => {
  if (at instanceof Date) return at.toISOString()
  return typeof at === "string" ? at : ""
}

// The row's check, or null when it has none (never checked, or cleared for a
// re-check).
export function toSkuCheck(row: VariantCheckRow | null | undefined): SkuCheck | null {
  if (!row || !isSkuCheckStatus(row.check_status)) return null
  const check: SkuCheck = { sku: row.check_sku ?? null, status: row.check_status, checked_at: iso(row.checked_at) }
  if (row.check_matched_sku) check.matched_sku = row.check_matched_sku
  if (row.check_note === "numeric-override") check.note = "numeric-override"
  return check
}

// A check's time as a date, or null when it isn't one: a legacy check may
// carry none, or text that isn't a date, which the database won't take.
const checkedAt = (at: unknown): Date | null => {
  const date = at instanceof Date ? at : typeof at === "string" && at ? new Date(at) : null
  return date && !Number.isNaN(date.getTime()) ? date : null
}

// Every check column, so a write always replaces the whole check: an absent
// matched_sku or note is written as null. A null check clears it.
export function checkColumns(check: SkuCheck | null, source: CheckSource): CheckColumns {
  return {
    check_sku: check?.sku ?? null,
    check_status: check?.status ?? null,
    check_matched_sku: check?.matched_sku ?? null,
    check_note: check?.note ?? null,
    checked_at: check ? checkedAt(check.checked_at) : null,
    check_source: source,
  }
}

// The check a variant's metadata carried before 1.0.0, when it is an object
// with a known status.
export function legacyCheckOf(metadata: Record<string, unknown> | null | undefined): SkuCheck | null {
  const value = metadata?.[LEGACY_SKU_CHECK_KEY]
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const c = value as { sku?: unknown; status?: unknown; checked_at?: unknown; matched_sku?: unknown; note?: unknown }
  if (!isSkuCheckStatus(c.status)) return null
  const check: SkuCheck = {
    sku: typeof c.sku === "string" ? c.sku : null,
    status: c.status,
    checked_at: typeof c.checked_at === "string" ? c.checked_at : "",
  }
  if (typeof c.matched_sku === "string" && c.matched_sku) check.matched_sku = c.matched_sku
  if (c.note === "numeric-override") check.note = "numeric-override"
  return check
}

// The variant's check: its row's when it has one (even a cleared one), else
// the legacy check in its metadata.
export function storedCheck(
  row: VariantCheckRow | null | undefined,
  metadata: Record<string, unknown> | null | undefined
): SkuCheck | null {
  return row ? toSkuCheck(row) : legacyCheckOf(metadata)
}

// What the SKU check would store for Print Trail's status (API 1.3.0), or
// null when the status is missing or unknown.
const wantedStatus = (status: unknown): SkuCheckStatus | null =>
  status === "active" ? "matched" : status === "inactive" ? "inactive" : status === "pre-order" ? "pre-order" : null

const LIVE: readonly string[] = ["matched", "pre-order"]

export type CheckRefreshes = {
  // A status the stock sync can write itself: between matched and pre-order,
  // or to inactive. `expect` is the check as read, so one changed since is
  // left alone.
  set: { id: string; expect: { sku: string | null; status: string }; status: SkuCheckStatus }[]
  // A check that becomes matched or pre-order from inactive, not-found or
  // error: cleared and queued, so the SKU check makes the change and its
  // follow-ups (re-sending blocked orders, refreshing stock).
  recheck: { id: string; variantId: string; expect: { sku: string | null; status: string } }[]
}

// The stored checks the stock sync's statuses (statusBySku) say are out of
// date. Each row is looked up by its matched_sku, then its own SKU. A row
// whose SKU isn't listed (never downgraded on absence), whose listed status
// is missing or unknown, or whose check is no-sku or cleared, is left alone.
export function checkRefreshes(rows: VariantCheckRow[], statuses: Map<string, PtStockLevel>): CheckRefreshes {
  const out: CheckRefreshes = { set: [], recheck: [] }
  for (const row of rows) {
    const stored = row.check_status
    if (!isSkuCheckStatus(stored) || stored === "no-sku") continue
    const level =
      (row.check_matched_sku ? statuses.get(normaliseSku(row.check_matched_sku)) : undefined) ??
      (row.check_sku ? statuses.get(normaliseSku(row.check_sku)) : undefined)
    const wanted = wantedStatus(level?.status)
    if (!wanted || wanted === stored) continue
    const expect = { sku: row.check_sku, status: stored }
    if (wanted === "inactive" || LIVE.includes(stored)) {
      out.set.push({ id: row.id, expect, status: wanted })
    } else {
      out.recheck.push({ id: row.id, variantId: row.variant_id, expect })
    }
  }
  return out
}
