import { defineLink } from "@medusajs/framework/utils"
import OrderModule from "@medusajs/medusa/order"
import PrintTrailModule from "../modules/printTrail"

// isList: claims, exchanges and released pre-orders add rows to one order.
export default defineLink(
  { linkable: PrintTrailModule.linkable.printTrailOrder, isList: true },
  OrderModule.linkable.order
)
