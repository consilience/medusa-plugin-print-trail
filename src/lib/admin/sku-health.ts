import type { SkuProblem, StockRunView } from "../admin-types"
import type { StockLastRun } from "../stock-flow"
import { storedCheck, type VariantCheckRow } from "../variant-checks"

const PROBLEM_STATUSES = new Set(["inactive", "not-found", "no-sku", "error"])

type HealthVariant = {
  id: string
  product_id: string
  title?: string | null
  sku?: string | null
  metadata?: Record<string, unknown> | null
  product?: { title?: string | null } | null
}

// Problems are listed; variants never checked are only counted (the SKU
// check runs on save, so an existing catalogue would flood the list). rows:
// the variants' print_trail_variant rows by variant id; a variant without one
// shows its legacy check from metadata.
export function skuProblems(
  variants: HealthVariant[],
  rows: Map<string, VariantCheckRow>
): { problems: SkuProblem[]; unchecked: number } {
  const problems: SkuProblem[] = []
  let unchecked = 0
  for (const v of variants) {
    const check = storedCheck(rows.get(v.id), v.metadata)
    if (!check) {
      unchecked++
      continue
    }
    if (!PROBLEM_STATUSES.has(check.status)) continue
    problems.push({
      variant_id: v.id,
      product_id: v.product_id,
      product_title: v.product?.title ?? null,
      variant_title: v.title ?? null,
      sku: check.sku,
      status: check.status,
      checked_at: check.checked_at || null,
    })
  }
  return { problems, unchecked }
}

export function lastRunView(run: StockLastRun | null): StockRunView | null {
  if (!run) return null
  return {
    trigger: run.trigger,
    completedAt: run.completedAt ?? null,
    levelsUpdated: run.levelsUpdated ?? 0,
    skipped: Array.isArray(run.skipped) ? run.skipped : [],
    warnings: Array.isArray(run.warnings) ? run.warnings : [],
    error: run.error ?? null,
  }
}
