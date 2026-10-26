import { asValue } from "@medusajs/framework/awilix"
import type { LoaderOptions } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { detectLocking, lockingMessage } from "../../../lib/locking-check"

export const LOCKING_CHECK_REGISTRATION = "printTrailLockingCheck"

// At startup: which locking provider the plugin's locks will use. An
// unsupported one is logged at error; the service records the result in
// print_trail_state for the settings page.
export default async function checkLockingLoader({ container }: LoaderOptions) {
  const config = container.resolve(ContainerRegistrationKeys.CONFIG_MODULE, { allowUnregistered: true })
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const check = detectLocking(config)
  const { level, text } = lockingMessage(check)
  logger[level](text)
  container.register(LOCKING_CHECK_REGISTRATION, asValue(check))
}
