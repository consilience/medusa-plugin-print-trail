// Print Trail matches SKUs case-insensitively, so every comparison here does
// too.
export function normaliseSku(sku?: string | null): string {
  return (sku ?? "").trim().toLowerCase()
}

export function skusMatch(a?: string | null, b?: string | null): boolean {
  const x = normaliseSku(a)
  return x !== "" && x === normaliseSku(b)
}

// A numeric print_trail_sku: Medusa's admin metadata form saves digits-only
// values as numbers. A finite integer is read as its digits (leading zeros,
// as in an ISBN-10, are already lost; the SKU check flags it).
export function overrideOf(metadata?: Record<string, unknown> | null): string | null {
  const override = metadata?.print_trail_sku
  if (typeof override === "string" && override.trim()) return override.trim()
  if (typeof override === "number" && Number.isSafeInteger(override)) return String(override)
  return null
}

export const isNumericOverride = (metadata?: Record<string, unknown> | null) =>
  typeof metadata?.print_trail_sku === "number" && overrideOf(metadata) !== null

// Variant metadata `print_trail_sku` overrides the variant SKU. Medusa has no
// parent product SKU, so there is nothing further to inherit.
export function resolveSku(variant: {
  sku?: string | null
  metadata?: Record<string, unknown> | null
}): string | null {
  return overrideOf(variant.metadata) ?? (variant.sku?.trim() || null)
}
