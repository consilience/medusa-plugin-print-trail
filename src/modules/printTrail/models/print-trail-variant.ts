import { model } from "@medusajs/framework/utils"

// One row per checked variant: the SKU check, kept here rather than in the
// variant's metadata, which store routes return. Typed columns, no JSON:
// service updates merge JSON objects. check_status null means no check
// (cleared for a re-check). Rows are hard-deleted when the variant goes.
const PrintTrailVariant = model.define("print_trail_variant", {
  id: model.id({ prefix: "ptvar" }).primaryKey(),
  variant_id: model.text().unique(),
  product_id: model.text().index(),
  check_sku: model.text().nullable(),
  check_status: model.text().index().nullable(),
  check_matched_sku: model.text().nullable(),
  // "numeric-override": print_trail_sku was saved as a number.
  check_note: model.text().nullable(),
  checked_at: model.dateTime().nullable(),
  // Who wrote the check: "sku-check", "stock-sync" or "metadata" (adopted
  // from the variant's metadata on upgrade).
  check_source: model.text().nullable(),
})

export default PrintTrailVariant
