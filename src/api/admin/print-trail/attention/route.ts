import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { AttentionList } from "../../../../lib/admin-types"
import { toAttentionRows } from "../../../../lib/admin/attention"
import { loadHealth } from "../../../../lib/admin/order-routes"
import { TEAM_CODE_STATE_KEY, type TeamCodeState } from "../../../../lib/team-code"
import { PRINT_TRAIL_MODULE } from "../../../../modules/printTrail"
import type PrintTrailModuleService from "../../../../modules/printTrail/service"
import type { GetAttentionType } from "../validators"

// Print Trail orders needing attention, newest first, queried from the
// plugin's side (query.graph can't filter orders by a linked module's field).
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const { limit, offset } = req.validatedQuery as GetAttentionType
  const service = req.scope.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const [rows, count] = await service.listAndCountPrintTrailOrders(
    { attention: { $ne: null } },
    { skip: offset, take: limit, order: { updated_at: "DESC" } }
  )
  const orderIds = [...new Set(rows.map((r) => r.order_id))]
  const { data: orders } = orderIds.length
    ? await query.graph({ entity: "order", fields: ["id", "display_id"], filters: { id: orderIds } })
    : { data: [] }
  const displayIds = new Map(orders.map((o) => [o.id as string, o.display_id as number]))
  const [team, health, options] = await Promise.all([
    service.getState<TeamCodeState>(TEAM_CODE_STATE_KEY),
    loadHealth(service),
    service.getOptions(),
  ])
  const body: AttentionList = {
    rows: toAttentionRows(rows as never, displayIds, options, team?.teamCode ?? null),
    count,
    limit,
    offset,
    health,
  }
  res.json(body)
}
