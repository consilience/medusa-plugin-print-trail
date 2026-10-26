import type { ModuleProviderExports } from "@medusajs/framework/types"
import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import { PrintTrailFulfillmentService } from "./service"

// Annotated so the declaration names @medusajs/framework, which a store has,
// rather than @medusajs/types, which it may not.
const provider: ModuleProviderExports = ModuleProvider(Modules.FULFILLMENT, {
  services: [PrintTrailFulfillmentService],
})

export default provider
