import type { SkuCheck, SkuCheckStatus } from "./sku-check"

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

// Every check column, so a write always replaces the whole check: an absent
// matched_sku or note is written as null. A null check clears it.
export function checkColumns(check: SkuCheck | null, source: CheckSource): CheckColumns {
  return {
    check_sku: check?.sku ?? null,
    check_status: check?.status ?? null,
    check_matched_sku: check?.matched_sku ?? null,
    check_note: check?.note ?? null,
    checked_at: check ? new Date(check.checked_at) : null,
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
