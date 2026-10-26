import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { PRINT_TRAIL_MODULE } from "../../modules/printTrail"
import type PrintTrailModuleService from "../../modules/printTrail/service"
import { GATE_ORDER_FIELDS } from "../../lib/lines"
import type { GateState, SendContext, SendStore } from "../../lib/send-flow"

export async function buildSendContext(container: MedusaContainer): Promise<SendContext> {
  const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  const link = container.resolve(ContainerRegistrationKeys.LINK)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const linkTo = (rowId: string, orderId: string) => ({
    [PRINT_TRAIL_MODULE]: { print_trail_order_id: rowId },
    [Modules.ORDER]: { order_id: orderId },
  })
  const store: SendStore = {
    listPrintTrailOrders: (filters) => service.listPrintTrailOrders(filters) as never,
    updatePrintTrailOrders: (data) => service.updatePrintTrailOrders(data as never) as never,
    createPrintTrailOrderEvents: (data) => service.createPrintTrailOrderEvents(data as never) as never,
    listPrintTrailOrderEvents: (filters) => service.listPrintTrailOrderEvents(filters) as never,
    markPreOrderSeen: (skus) => service.markPreOrderSeen(skus),
    // Each row is linked to its order as soon as it exists, so the order's
    // Print Trail rows can be read through query.graph.
    async createPrintTrailOrders(data) {
      const row = (await service.createPrintTrailOrders(data as never)) as never as { id: string }
      await link.create(linkTo(row.id, data.order_id as string))
      return row as never
    },
    // Link.list filters on both sides of the definition, so an empty result
    // means this pair isn't linked.
    async ensureOrderLink(row) {
      const def = linkTo(row.id, row.order_id)
      if (!(await link.list(def)).length) {
        await link.create(def)
      }
    },
  }
  return {
    store,
    client: await service.getClient(),
    options: await service.getOptions(),
    async reloadGateState(orderId) {
      const { data } = await query.graph({ entity: "order", fields: GATE_ORDER_FIELDS, filters: { id: orderId } })
      return (data[0] as unknown as GateState | undefined) ?? null
    },
  }
}
