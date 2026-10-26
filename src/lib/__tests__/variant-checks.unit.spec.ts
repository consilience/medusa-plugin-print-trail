import type { PtStockLevel } from "../../modules/printTrail/client/types"
import type { SkuCheck, SkuCheckStatus } from "../sku-check"
import { statusBySku } from "../stock"
import {
  checkColumns,
  checkRefreshes,
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

  // The database refuses an invalid date, which would fail every write of
  // the page it is on.
  it("write a check whose time is missing or isn't a date with a null checked_at", () => {
    for (const checked_at of ["", "yesterday", "2026-13-45T99:00:00Z", undefined, 42, null]) {
      const columns = checkColumns({ sku: "A", status: "matched", checked_at } as unknown as SkuCheck, "metadata")
      expect(columns).toMatchObject({ check_sku: "A", check_status: "matched", checked_at: null })
    }
    expect(checkColumns({ sku: "A", status: "matched", checked_at: AT }, "metadata").checked_at).toEqual(new Date(AT))
    // Read back, the check has no time, as a legacy check without one does.
    expect(toSkuCheck(row({ check_sku: "A", check_status: "matched", checked_at: null }))).toEqual({ sku: "A", status: "matched", checked_at: "" })
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

  // Hand-edited or imported metadata: the check is kept, and its time
  // becomes null when it is stored (checkColumns).
  it("keeps a legacy check whose checked_at is missing, not a string or not a date", () => {
    for (const checked_at of [undefined, 42, null, { at: AT }, "not a date"]) {
      const check = legacyCheckOf({ [LEGACY_SKU_CHECK_KEY]: { sku: "OLD-1", status: "not-found", checked_at } })
      expect(check).toEqual({ sku: "OLD-1", status: "not-found", checked_at: typeof checked_at === "string" ? checked_at : "" })
      expect(checkColumns(check, "metadata")).toMatchObject({ check_sku: "OLD-1", check_status: "not-found", checked_at: null, check_source: "metadata" })
    }
  })

  it("rejects a malformed legacy value", () => {
    for (const value of ["matched", true, ["matched"], { status: "unheard-of" }, { sku: "A" }, null, ""]) {
      expect(legacyCheckOf({ [LEGACY_SKU_CHECK_KEY]: value })).toBeNull()
      expect(storedCheck(null, { [LEGACY_SKU_CHECK_KEY]: value })).toBeNull()
    }
  })
})

// The stock sync's statuses against the stored checks.
describe("checkRefreshes", () => {
  const stored = (status: string | null, over: Partial<VariantCheckRow> = {}) =>
    row({ id: "ptvar_1", variant_id: "variant_1", check_sku: "SKU-1", check_status: status, checked_at: AT, ...over })
  const listed = (status: unknown, sku = "SKU-1") => statusBySku([{ sku, stock: 5, status } as PtStockLevel])
  const expectOf = (status: string) => ({ sku: "SKU-1", status })

  it("follows each transition in the table", () => {
    // [stored, Print Trail's status, what happens]
    const table: [string, string, "set" | "recheck" | null, string?][] = [
      ["matched", "pre-order", "set", "pre-order"],
      ["pre-order", "active", "set", "matched"],
      ["matched", "inactive", "set", "inactive"],
      ["pre-order", "inactive", "set", "inactive"],
      ["not-found", "inactive", "set", "inactive"],
      ["error", "inactive", "set", "inactive"],
      ["inactive", "active", "recheck"],
      ["inactive", "pre-order", "recheck"],
      ["not-found", "active", "recheck"],
      ["not-found", "pre-order", "recheck"],
      ["error", "active", "recheck"],
      ["matched", "active", null],
      ["pre-order", "pre-order", null],
      ["inactive", "inactive", null],
    ]
    for (const [from, status, what, to] of table) {
      const result = checkRefreshes([stored(from)], listed(status))
      const expected = {
        set: what === "set" ? [{ id: "ptvar_1", expect: expectOf(from), status: to }] : [],
        recheck: what === "recheck" ? [{ id: "ptvar_1", variantId: "variant_1", expect: expectOf(from) }] : [],
      }
      expect({ from, status, result }).toEqual({ from, status, result: expected })
    }
  })

  it("leaves a no-sku check, and a cleared one, alone", () => {
    for (const status of ["active", "inactive", "pre-order"]) {
      expect(checkRefreshes([stored("no-sku", { check_sku: null })], listed(status))).toEqual({ set: [], recheck: [] })
      expect(checkRefreshes([stored(null)], listed(status))).toEqual({ set: [], recheck: [] })
    }
  })

  it("a SKU missing from stock levels is never downgraded", () => {
    for (const status of ["matched", "pre-order", "inactive", "not-found"]) {
      expect(checkRefreshes([stored(status)], listed("inactive", "OTHER-SKU"))).toEqual({ set: [], recheck: [] })
    }
  })

  it("a listed SKU without a known status changes nothing", () => {
    for (const status of [undefined, null, "", "retired"]) {
      expect(checkRefreshes([stored("matched"), stored("not-found", { id: "ptvar_2" })], listed(status))).toEqual({ set: [], recheck: [] })
    }
  })

  it("an alias is matched by its matched_sku", () => {
    const alias = stored("matched", { check_sku: "isbn-alias", check_matched_sku: "CANON-1" })
    expect(checkRefreshes([alias], listed("inactive", "canon-1")).set).toEqual([
      { id: "ptvar_1", expect: { sku: "isbn-alias", status: "matched" }, status: "inactive" },
    ])
    // The matched SKU isn't listed: its own SKU is.
    expect(checkRefreshes([alias], listed("pre-order", " ISBN-ALIAS ")).set).toEqual([
      { id: "ptvar_1", expect: { sku: "isbn-alias", status: "matched" }, status: "pre-order" },
    ])
  })

  it("matches SKUs however they are cased or spaced", () => {
    expect(checkRefreshes([stored("matched", { check_sku: " sku-1" })], listed("inactive", "SKU-1 ")).set).toHaveLength(1)
  })
})
