import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { PRINT_TRAIL_MODULE } from "../../modules/printTrail"
import type PrintTrailModuleService from "../../modules/printTrail/service"
import type { OrderView } from "../admin-types"
import { AUTH_FAILED_STATE_KEY, CHANNEL_INACTIVE_STATE_KEY, type AuthFailedState, type ChannelInactiveState } from "../auth-state"
import { attachShippingOptions, hasPrintTrailMethod, SHIPPING_OPTION_FIELDS, shippingOptionIds } from "../lines"
import type { PrintTrailOrderRow } from "../send-flow"
import { readUnmatchedSkus } from "../stock"
import { TEAM_CODE_STATE_KEY, type TeamCodeState } from "../team-code"
import { healthView } from "./connection-decisions"
import { buildOrderView } from "./order-view"

type LoadedOrder = { id: string; display_id: number | null; canceled: boolean; hasPtShippingMethod: boolean }

export async function loadAdminOrder(scope: MedusaContainer, orderId: string): Promise<LoadedOrder> {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: ["id", "display_id", "status", "canceled_at", "shipping_methods.shipping_option_id"],
    filters: { id: orderId },
  })
  const order = data[0] as
    | { id: string; display_id?: number | null; status?: string; canceled_at?: unknown; shipping_methods?: { shipping_option_id?: string | null }[] }
    | undefined
  if (!order) throw new MedusaError(MedusaError.Types.NOT_FOUND, `Order ${orderId} was not found`)
  // Order shipping methods aren't linked to options (carts only): join here.
  const ids = shippingOptionIds([order])
  const { data: options } = ids.length
    ? await query.graph({ entity: "shipping_option", fields: SHIPPING_OPTION_FIELDS, filters: { id: ids }, withDeleted: true })
    : { data: [] }
  return {
    id: order.id,
    display_id: order.display_id ?? null,
    canceled: !!order.canceled_at || order.status === "canceled",
    hasPtShippingMethod: hasPrintTrailMethod(attachShippingOptions(order, options as never) as never),
  }
}

export async function loadRows(scope: MedusaContainer, orderId: string): Promise<PrintTrailOrderRow[]> {
  const service = scope.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  return (await service.listPrintTrailOrders({ order_id: orderId })) as unknown as PrintTrailOrderRow[]
}

// A row of this order, or a 404: a body can't reach another order's rows.
export function rowOfOrder(rows: PrintTrailOrderRow[], id: string | undefined): PrintTrailOrderRow | null {
  if (id === undefined) return null
  const row = rows.find((r) => r.id === id)
  if (!row) throw new MedusaError(MedusaError.Types.NOT_FOUND, `Print Trail order ${id} isn't on this order`)
  return row
}

export async function loadHealth(service: PrintTrailModuleService) {
  const [authFailed, unmatched, channelInactive] = await Promise.all([
    service.getState<AuthFailedState>(AUTH_FAILED_STATE_KEY),
    readUnmatchedSkus(service),
    service.getState<ChannelInactiveState>(CHANNEL_INACTIVE_STATE_KEY),
  ])
  return healthView(authFailed, unmatched, channelInactive)
}

export async function orderView(scope: MedusaContainer, orderId: string): Promise<OrderView> {
  const service = scope.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  const order = await loadAdminOrder(scope, orderId)
  const rows = await loadRows(scope, orderId)
  if (!rows.length && !order.hasPtShippingMethod) {
    // Not a Print Trail order: nothing else to load, and the widgets hide.
    return buildOrderView({ order, rows, events: [], options: await service.getOptions(), teamCode: null, health: { reconnect: false, channelInactive: false, unmatchedSkus: 0 }, now: new Date() })
  }
  const [events, team, health, options] = await Promise.all([
    service.listPrintTrailOrderEvents({ order_id: orderId }, { order: { created_at: "DESC" }, take: 100 }),
    service.getState<TeamCodeState>(TEAM_CODE_STATE_KEY),
    loadHealth(service),
    service.getOptions(),
  ])
  return buildOrderView({
    order,
    rows,
    events: events as never,
    options,
    teamCode: team?.teamCode ?? null,
    health,
    now: new Date(),
  })
}
