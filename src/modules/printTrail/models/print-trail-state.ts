import { model } from "@medusajs/framework/utils"

// Key-value store: reconcile cursor, stock watermark, unmatched SKUs, auth state.
const PrintTrailState = model.define("print_trail_state", {
  id: model.id({ prefix: "ptst" }).primaryKey(),
  key: model.text().unique(),
  value: model.json().nullable(),
})

export default PrintTrailState
