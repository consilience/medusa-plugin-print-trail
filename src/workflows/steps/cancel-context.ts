import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { CancelContext } from "../../lib/cancel-flow"
import { containerNotifier } from "../../lib/notifier"
import { TEAM_CODE_STATE_KEY, type TeamCodeState } from "../../lib/team-code"
import { PRINT_TRAIL_MODULE } from "../../modules/printTrail"
import type PrintTrailModuleService from "../../modules/printTrail/service"
import { buildSyncStore } from "./sync-context"

export async function orderDisplayId(container: MedusaContainer, orderId: string): Promise<number | string | null> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({ entity: "order", fields: ["id", "display_id"], filters: { id: orderId } })
  return (data[0]?.display_id as number | undefined) ?? null
}

// Whether Medusa has cancelled the order. Only then does a cancel run reach
// every row; otherwise it runs only the rows already asked to cancel (an
// emptied draft's cancel), with their own cause.
export async function isOrderCanceled(container: MedusaContainer, orderId: string): Promise<boolean> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({ entity: "order", fields: ["id", "status", "canceled_at"], filters: { id: orderId } })
  const order = data[0] as { canceled_at?: unknown; status?: string } | undefined
  return !!order?.canceled_at || order?.status === "canceled"
}

export async function buildCancelContext(container: MedusaContainer, orderId: string): Promise<CancelContext> {
  const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  const team = await service.getState<TeamCodeState>(TEAM_CODE_STATE_KEY)
  return {
    store: buildSyncStore(service),
    client: await service.getClient(),
    options: await service.getOptions(),
    teamCode: team?.teamCode ?? null,
    notifier: containerNotifier(container),
    logger: container.resolve(ContainerRegistrationKeys.LOGGER),
    order: { id: orderId, display_id: await orderDisplayId(container, orderId) },
    orderCanceled: await isOrderCanceled(container, orderId),
  }
}
