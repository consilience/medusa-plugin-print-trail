// Medusa before 2.19 replaces a variant's metadata on update (the product
// module's updateVariants_ uses upsertWithReplace), so the SKU override is
// saved by sending the variant's whole current metadata with only
// print_trail_sku changed. Sending the key alone would erase the SKU check
// and the print-on-demand marker. From 2.19.0 Medusa merges the update into
// the stored metadata, so leaving the key out would keep it: an empty value
// removes the override by sending print_trail_sku as "", Medusa's way to
// delete a metadata key. Before 2.19 that stores "", which the plugin reads
// as no override (as Medusa's own metadata form leaves it there).
export function variantOverridePayload(
  current: Record<string, unknown> | null | undefined,
  input: string
): { metadata: Record<string, unknown> } {
  const metadata: Record<string, unknown> = { ...(current ?? {}) }
  const value = input.trim()
  if (value) metadata.print_trail_sku = value
  else if (Object.prototype.hasOwnProperty.call(metadata, "print_trail_sku")) metadata.print_trail_sku = ""
  return { metadata }
}
