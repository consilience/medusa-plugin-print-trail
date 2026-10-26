import { model } from "@medusajs/framework/utils"

// The order timeline: Medusa v2 has no order notes, so remote changes,
// refusals and retries are recorded here.
const PrintTrailOrderEvent = model.define("print_trail_order_event", {
  id: model.id({ prefix: "ptevt" }).primaryKey(),
  order_id: model.text().index(),
  print_trail_order_id: model.text().nullable(),
  kind: model.text(),
  message: model.text(),
  data: model.json().nullable(),
  customer_visible: model.boolean().default(false),
})

export default PrintTrailOrderEvent
