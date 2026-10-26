import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import {
  completeOrderWorkflow,
  createOrderFulfillmentWorkflow,
  createOrderShipmentWorkflow,
  updateFulfillmentWorkflow,
} from "@medusajs/medusa/core-flows"
import { PRINT_TRAIL_PROVIDER_ID, SHIPPING_OPTION_FIELDS, shippingOptionIds, type ShippingOptionInfo } from "../../lib/lines"
import { containerNotifier } from "../../lib/notifier"
import { sendPrintTrailShipmentEmail } from "../../lib/notify-shipment"
import type { DispatchOrder } from "../../lib/sync-decisions"
import type { MedusaOrderPort, SyncContext, SyncStore } from "../../lib/sync-flow"
import { TEAM_CODE_STATE_KEY, type TeamCodeState } from "../../lib/team-code"
import { PRINT_TRAIL_MODULE } from "../../modules/printTrail"
import type PrintTrailModuleService from "../../modules/printTrail/service"

// Quantities come from items.detail (plain items.quantity is absent unless
// items.* is selected).
export const DISPATCH_ORDER_FIELDS = [
  "id",
  "status",
  "canceled_at",
  "items.id",
  "items.detail.quantity",
  "items.detail.fulfilled_quantity",
  "items.variant.product.shipping_profile.id",
  "shipping_methods.shipping_option_id",
  "fulfillments.id",
  "fulfillments.shipped_at",
  "fulfillments.canceled_at",
  "fulfillments.metadata",
  "fulfillments.labels.id",
  "fulfillments.labels.tracking_number",
  "fulfillments.labels.tracking_url",
  "fulfillments.labels.label_url",
]

type GraphDispatchOrder = {
  id: string
  status?: string | null
  canceled_at?: Date | string | null
  items?: ({
    id: string
    detail?: { quantity?: number | string | null; fulfilled_quantity?: number | string | null } | null
    variant?: { product?: { shipping_profile?: { id?: string | null } | null } | null } | null
  } | null)[] | null
  fulfillments?: ({
    id: string
    shipped_at?: Date | string | null
    canceled_at?: Date | string | null
    metadata?: Record<string, unknown> | null
    labels?: ({ id: string; tracking_number?: string | null; tracking_url?: string | null; label_url?: string | null } | null)[] | null
  } | null)[] | null
}

export function toDispatchOrder(graphOrder: unknown, options: ShippingOptionInfo[]): DispatchOrder {
  const o = graphOrder as GraphDispatchOrder
  const ptOptionIdByProfile: Record<string, string> = {}
  for (const option of options) {
    if (option.provider_id === PRINT_TRAIL_PROVIDER_ID && option.shipping_profile_id) {
      ptOptionIdByProfile[option.shipping_profile_id] = option.id
    }
  }
  return {
    id: o.id,
    status: o.status ?? null,
    canceled_at: o.canceled_at ?? null,
    items: (o.items ?? []).flatMap((i) =>
      i
        ? [
            {
              id: i.id,
              quantity: Number(i.detail?.quantity ?? 0),
              fulfilled_quantity: Number(i.detail?.fulfilled_quantity ?? 0),
              shipping_profile_id: i.variant?.product?.shipping_profile?.id ?? null,
            },
          ]
        : []
    ),
    fulfillments: (o.fulfillments ?? []).flatMap((f) =>
      f
        ? [
            {
              id: f.id,
              shipped_at: f.shipped_at ?? null,
              canceled_at: f.canceled_at ?? null,
              metadata: f.metadata ?? null,
              labels: (f.labels ?? []).flatMap((l) =>
                l
                  ? [
                      {
                        id: l.id,
                        tracking_number: l.tracking_number ?? "",
                        tracking_url: l.tracking_url ?? "",
                        label_url: l.label_url ?? "",
                      },
                    ]
                  : []
              ),
            },
          ]
        : []
    ),
    ptOptionIdByProfile,
  }
}

const isAlreadyShipped = (e: unknown) =>
  e instanceof Error &&
  (e as MedusaError).type === MedusaError.Types.NOT_ALLOWED &&
  /already been created/i.test(e.message)

export function buildMedusaOrderPort(container: MedusaContainer): MedusaOrderPort {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  return {
    async loadDispatchOrder(orderId) {
      const { data } = await query.graph({ entity: "order", fields: DISPATCH_ORDER_FIELDS, filters: { id: orderId } })
      const order = data[0]
      if (!order) {
        return null
      }
      // Orders have no link to shipping options (only carts do).
      const ids = shippingOptionIds([order as never])
      const { data: options } = ids.length
        ? await query.graph({
            entity: "shipping_option",
            fields: SHIPPING_OPTION_FIELDS,
            filters: { id: ids },
            withDeleted: true,
          })
        : { data: [] }
      return toDispatchOrder(order, options as unknown as ShippingOptionInfo[])
    },
    // No location_id: Medusa then uses the reservation's location. No labels:
    // the provider's empty labels would erase them; tracking goes on the
    // shipment.
    async createFulfilment(orderId, c) {
      const { result } = await createOrderFulfillmentWorkflow(container).run({
        input: { order_id: orderId, shipping_option_id: c.shippingOptionId, items: c.items, metadata: c.metadata },
      })
      return { id: result.id }
    },
    async createShipment(orderId, fulfillmentId, items, labels) {
      try {
        await createOrderShipmentWorkflow(container).run({
          input: { order_id: orderId, fulfillment_id: fulfillmentId, items, labels },
        })
      } catch (e) {
        if (!isAlreadyShipped(e)) throw e
      }
    },
    // A shipped fulfilment can't get a second shipment: the labels are
    // updated (existing ones kept by id) and the new numbers emailed.
    async addLabels(fulfillmentId, keep, added) {
      await updateFulfillmentWorkflow(container).run({
        // UpdateFulfillmentWorkflowInput doesn't declare labels, but the step
        // passes them to updateFulfillment, which keeps labels given by id.
        input: { id: fulfillmentId, labels: [...keep, ...added] } as never,
      })
      await sendPrintTrailShipmentEmail(container, fulfillmentId, { only: added })
    },
    async completeOrder(orderId) {
      await completeOrderWorkflow(container).run({ input: { orderIds: [orderId] } })
    },
  }
}

export function buildSyncStore(service: PrintTrailModuleService): SyncStore {
  return {
    listPrintTrailOrders: (filters) => service.listPrintTrailOrders(filters) as never,
    updatePrintTrailOrders: (data) => service.updatePrintTrailOrders(data as never) as never,
    createPrintTrailOrderEvents: (data) => service.createPrintTrailOrderEvents(data as never) as never,
    listPrintTrailOrderEvents: (filters) => service.listPrintTrailOrderEvents(filters) as never,
    markPreOrderSeen: (skus) => service.markPreOrderSeen(skus),
  }
}

// Reads only the stored team code; GET /token is reconcile's and "Test
// connection"'s job.
export async function buildSyncContext(container: MedusaContainer): Promise<SyncContext> {
  const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  const team = await service.getState<TeamCodeState>(TEAM_CODE_STATE_KEY)
  return {
    store: buildSyncStore(service),
    client: await service.getClient(),
    options: await service.getOptions(),
    medusa: buildMedusaOrderPort(container),
    teamCode: team?.teamCode ?? null,
    state: service,
    logger: container.resolve(ContainerRegistrationKeys.LOGGER),
    notifier: containerNotifier(container),
    async orderDisplayId(orderId) {
      const query = container.resolve(ContainerRegistrationKeys.QUERY)
      const { data } = await query.graph({ entity: "order", fields: ["id", "display_id"], filters: { id: orderId } })
      return (data[0]?.display_id as number | undefined) ?? null
    },
  }
}
