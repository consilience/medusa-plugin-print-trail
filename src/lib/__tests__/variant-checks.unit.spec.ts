import type { SkuCheck, SkuCheckStatus } from "../sku-check"
import {
  checkColumns,
  LEGACY_SKU_CHECK_KEY,
  legacyCheckOf,
  storedCheck,
  toSkuCheck,
  type VariantCheckRow,
} from "../variant-checks"

const AT = "2026-10-19T12:00:00.000Z"
const STATUSES: SkuCheckStatus[] = ["matched", "inactive", "pre-order", "not-found", "no-sku", "error"]

const row = (over: Partial<VariantCheckRow> = {}): VariantCheckRow => ({
  id: "ptvar_1",
  variant_id: "variant_1",
  product_id: "prod_1",
  check_sku: null,
  check_status: null,
  check_matched_sku: null,
  check_note: null,
  checked_at: null,
  check_source: null,
  ...over,
})

describe("toSkuCheck and checkColumns", () => {
  it("round-trip every status, with and without matched_sku and note", () => {
    for (const status of STATUSES) {
      const plain: SkuCheck = { sku: status === "no-sku" ? null : "SKU-1", status, checked_at: AT }
      const full: SkuCheck = { ...plain, matched_sku: "sku-canon", note: "numeric-override" }
      for (const check of [plain, full]) {
        expect(toSkuCheck(row(checkColumns(check, "sku-check")))).toEqual(check)
      }
    }
  })

  it("write every check column, so a check without matched_sku replaces one that had it", () => {
    const before = row(checkColumns({ sku: "SKU-1", status: "matched", checked_at: AT, matched_sku: "sku-canon", note: "numeric-override" }, "sku-check"))
    const after = { ...before, ...checkColumns({ sku: "SKU-1", status: "matched", checked_at: AT }, "stock-sync") }
    expect(after.check_matched_sku).toBeNull()
    expect(after.check_note).toBeNull()
    expect(after.check_source).toBe("stock-sync")
    expect(toSkuCheck(after)).toEqual({ sku: "SKU-1", status: "matched", checked_at: AT })
  })

  it("write a cleared check as nulls", () => {
    expect(checkColumns(null, "stock-sync")).toEqual({
      check_sku: null,
      check_status: null,
      check_matched_sku: null,
      check_note: null,
      checked_at: null,
      check_source: "stock-sync",
    })
  })

  it("read a row without a status, or with an unknown one, as no check", () => {
    expect(toSkuCheck(null)).toBeNull()
    expect(toSkuCheck(undefined)).toBeNull()
    expect(toSkuCheck(row({ check_sku: "SKU-1" }))).toBeNull()
    expect(toSkuCheck(row({ check_sku: "SKU-1", check_status: "unheard-of", checked_at: AT }))).toBeNull()
  })

  it("read checked_at from a Date or a string", () => {
    expect(toSkuCheck(row({ check_sku: "A", check_status: "matched", checked_at: new Date(AT) }))?.checked_at).toBe(AT)
    expect(toSkuCheck(row({ check_sku: "A", check_status: "matched", checked_at: AT }))?.checked_at).toBe(AT)
  })
})

describe("storedCheck", () => {
  const legacy = { sku: "OLD-1", status: "not-found", checked_at: AT }

  it("prefers the variant's row, even a cleared one", () => {
    const metadata = { [LEGACY_SKU_CHECK_KEY]: legacy }
    expect(storedCheck(row({ check_sku: "NEW-1", check_status: "matched", checked_at: AT }), metadata)).toEqual({
      sku: "NEW-1",
      status: "matched",
      checked_at: AT,
    })
    // Cleared for a re-check: not the legacy check.
    expect(storedCheck(row(), metadata)).toBeNull()
  })

  it("falls back to a valid legacy check in metadata", () => {
    expect(storedCheck(null, { [LEGACY_SKU_CHECK_KEY]: legacy, other: 1 })).toEqual(legacy)
    expect(storedCheck(undefined, { [LEGACY_SKU_CHECK_KEY]: { ...legacy, matched_sku: "old-1", note: "numeric-override" } })).toEqual({
      ...legacy,
      matched_sku: "old-1",
      note: "numeric-override",
    })
    expect(storedCheck(null, null)).toBeNull()
  })

  it("rejects a malformed legacy value", () => {
    for (const value of ["matched", true, ["matched"], { status: "unheard-of" }, { sku: "A" }, null, ""]) {
      expect(legacyCheckOf({ [LEGACY_SKU_CHECK_KEY]: value })).toBeNull()
      expect(storedCheck(null, { [LEGACY_SKU_CHECK_KEY]: value })).toBeNull()
    }
  })
})
