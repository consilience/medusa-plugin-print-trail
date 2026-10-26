import type { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import type { AdminNotifier } from "./cancel-flow"

// The admin email goes through the store's notification provider.
export function containerNotifier(container: MedusaContainer): AdminNotifier {
  return {
    async notify(notifications) {
      if (!notifications.length) return
      await container.resolve(Modules.NOTIFICATION).createNotifications(notifications)
    },
  }
}
