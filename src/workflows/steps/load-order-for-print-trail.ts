import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import {
  allPrintTrailLines,
  attachShippingOptions,
  CLAIM_FIELDS,
  EXCHANGE_FIELDS,
  ORDER_FIELDS,
  SHIPPING_OPTION_FIELDS,
  shippingOptionIds,
  type GraphOrder,
  type ScopedLine,
  type SelectedLine,
  type ShippingOptionInfo,
} from "../../lib/lines"
import type { ScopeRow } from "../../lib/order-scope"
import { PRINT_TRAIL_MODULE } from "../../modules/printTrail"
import type PrintTrailModuleService from "../../modules/printTrail/service"

export type LoadedRow = ScopeRow & { pt_order_number: string }

// lines: the order's own Print Trail lines (sequence 1); allLines: every
// Print Trail line, claim and exchange items marked; rows: the order's
// print_trail_order rows.
export type LoadOrderForPrintTrailOutput = {
  order: GraphOrder
  lines: SelectedLine[]
  allLines: ScopedLine[]
  rows: LoadedRow[]
}

export const ROW_SCOPE_FIELDS = [
  "id",
  "sequence",
  "source_ref",
  "pt_uuid",
  "pt_order_number",
  "status",
  "confirmed_at",
  "cancel_status",
  "submitted_lines",
]

export const loadOrderForPrintTrailStep = createStep(
  "load-order-for-print-trail",
  async (input: { order_id: string }, { container }) => {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
    const { data } = await query.graph({
      entity: "order",
      fields: ORDER_FIELDS,
      filters: { id: input.order_id },
    })
    const found = data[0] as unknown as GraphOrder | undefined
    if (!found) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, `Order ${input.order_id} not found`)
    }
    const ids = shippingOptionIds([found])
    const { data: shippingOptions } = ids.length
      ? await query.graph({
          entity: "shipping_option",
          fields: SHIPPING_OPTION_FIELDS,
          filters: { id: ids },
          withDeleted: true,
        })
      : { data: [] }
    // See CLAIM_FIELDS: claims and exchanges aren't reachable from the order.
    const [{ data: claims }, { data: exchanges }] = await Promise.all([
      query.graph({ entity: "order_claim", fields: CLAIM_FIELDS, filters: { order_id: input.order_id } }),
      query.graph({ entity: "order_exchange", fields: EXCHANGE_FIELDS, filters: { order_id: input.order_id } }),
    ])
    const order: GraphOrder = {
      ...attachShippingOptions(found, shippingOptions as unknown as ShippingOptionInfo[]),
      claims: claims as unknown as GraphOrder["claims"],
      exchanges: exchanges as unknown as GraphOrder["exchanges"],
    }
    const options = await service.getOptions()
    const allLines = allPrintTrailLines(order, options.defaultShippingMethod)
    const lines = allLines.filter((l) => !l.replacementOf).map(({ replacementOf: _r, ...l }) => l)
    const rows = (await service.listPrintTrailOrders(
      { order_id: input.order_id },
      { select: ROW_SCOPE_FIELDS as never, order: { sequence: "ASC" } }
    )) as unknown as LoadedRow[]
    return new StepResponse<LoadOrderForPrintTrailOutput>({ order, lines, allLines, rows })
  }
)
