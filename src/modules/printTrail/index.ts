import { Module } from "@medusajs/framework/utils"
import checkLockingLoader from "./loaders/check-locking"
import PrintTrailModuleService from "./service"

export const PRINT_TRAIL_MODULE = "printTrail"

export default Module(PRINT_TRAIL_MODULE, {
  service: PrintTrailModuleService,
  loaders: [checkLockingLoader],
})
