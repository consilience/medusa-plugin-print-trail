import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import {
  attachShippingOptions,
  GATE_ORDER_FIELDS,
  ORDER_FIELDS,
  paymentTotals,
  type GraphOrder,
} from "../../lib/lines"
import {
  recordAddressChange,
  recordRefunds,
  recordReturn,
  type ChangeContext,
  type ChangeOutcome,
} from "../../lib/order-change-flow"
import { loadPayment } from "../../lib/payment-order"
import type { PrintTrailOrderRow } from "../../lib/send-flow"
import { TEAM_CODE_STATE_KEY, type TeamCodeState } from "../../lib/team-code"
import { PRINT_TRAIL_MODULE } from "../../modules/printTrail"
import type PrintTrailModuleService from "../../modules/printTrail/service"
import { buildSyncStore } from "./sync-context"

export type OrderChange =
  | { kind: "address" }
  | { kind: "refund"; payment_id: string }
  | { kind: "return"; return_id: string }

// Loads what the change needs and records it. No Print Trail call; a draft
// whose address changed is handed back in `resend`.
export const recordOrderChangeStep = createStep(
  "record-order-change",
  async (input: { order_id: string; change: OrderChange }, { container }) => {
    const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const rows = (await service.listPrintTrailOrders({ order_id: input.order_id })) as unknown as PrintTrailOrderRow[]
    const none: ChangeOutcome = { resend: [], events: [] }
    if (!rows.length) {
      return new StepResponse(none)
    }
    const team = await service.getState<TeamCodeState>(TEAM_CODE_STATE_KEY)
    const ctx: ChangeContext = {
      store: buildSyncStore(service),
      options: await service.getOptions(),
      teamCode: team?.teamCode ?? null,
    }
    const { change } = input
    if (change.kind === "address") {
      const { data } = await query.graph({ entity: "order", fields: ORDER_FIELDS, filters: { id: input.order_id } })
      const order = data[0] as unknown as GraphOrder | undefined
      return new StepResponse(order ? await recordAddressChange(ctx, rows, attachShippingOptions(order, [])) : none)
    }
    if (change.kind === "refund") {
      const payment = await loadPayment(query, change.payment_id)
      const { data } = await query.graph({ entity: "order", fields: GATE_ORDER_FIELDS, filters: { id: input.order_id } })
      const gateOrder = (data[0] ?? {}) as unknown as GraphOrder
      const totals = paymentTotals(gateOrder)
      const orderCanceled = !!gateOrder.canceled_at || gateOrder.status === "canceled"
      const refunds = (payment?.refunds ?? []).flatMap((r) =>
        r ? [{ id: r.id, amount: Number(r.amount ?? 0), currency_code: payment?.currency_code ?? null, created_at: r.created_at ?? null }] : []
      )
      return new StepResponse(await recordRefunds(ctx, rows, { refunds, ...totals, orderCanceled }))
    }
    const { data } = await query.graph({ entity: "return", fields: ["id", "items.item_id", "items.quantity"], filters: { id: change.return_id } })
    const ret = data[0] as unknown as { items?: ({ item_id: string; quantity: number | string } | null)[] } | undefined
    const items = (ret?.items ?? []).flatMap((i) => (i ? [{ item_id: i.item_id, quantity: Number(i.quantity ?? 0) }] : []))
    return new StepResponse(await recordReturn(ctx, rows, { returnId: change.return_id, items }))
  }
)
