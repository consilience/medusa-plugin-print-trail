import type { ModuleExports } from "@medusajs/framework/types"
import { Module } from "@medusajs/framework/utils"
import checkLockingLoader from "./loaders/check-locking"
import PrintTrailModuleService from "./service"

export const PRINT_TRAIL_MODULE = "printTrail"

const printTrailModule = Module(PRINT_TRAIL_MODULE, {
  service: PrintTrailModuleService,
  loaders: [checkLockingLoader],
})

// Cast so the declaration names @medusajs/framework, which a store has, rather
// than @medusajs/types, which it may not.
export default printTrailModule as ModuleExports<typeof PrintTrailModuleService> & {
  linkable: typeof printTrailModule.linkable
}
