import type { SkuProblem, StockRunView } from "../admin-types"
import { SKU_CHECK_KEY } from "../sku-check"
import type { StockLastRun } from "../stock-flow"

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
// check runs on save, so an existing catalogue would flood the list).
export function skuProblems(variants: HealthVariant[]): { problems: SkuProblem[]; unchecked: number } {
  const problems: SkuProblem[] = []
  let unchecked = 0
  for (const v of variants) {
    const check = v.metadata?.[SKU_CHECK_KEY] as { sku?: unknown; status?: unknown; checked_at?: unknown } | undefined
    if (!check || typeof check !== "object" || typeof check.status !== "string") {
      unchecked++
      continue
    }
    if (!PROBLEM_STATUSES.has(check.status)) continue
    problems.push({
      variant_id: v.id,
      product_id: v.product_id,
      product_title: v.product?.title ?? null,
      variant_title: v.title ?? null,
      sku: typeof check.sku === "string" ? check.sku : null,
      status: check.status,
      checked_at: typeof check.checked_at === "string" ? check.checked_at : null,
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
