import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import { PrintTrailFulfillmentService } from "./service"

export default ModuleProvider(Modules.FULFILLMENT, {
  services: [PrintTrailFulfillmentService],
})
