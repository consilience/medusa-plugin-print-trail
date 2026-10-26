import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { printTrailAppUrl } from "../../lib/app-url"
import type { GraphOrder } from "../../lib/lines"
import { printTrailOrderNumber } from "../../lib/order-number"
import { resolveSendTarget, type SendTarget } from "../../lib/order-scope"
import { TEAM_CODE_STATE_KEY, type TeamCodeState } from "../../lib/team-code"
import { PRINT_TRAIL_MODULE } from "../../modules/printTrail"
import type PrintTrailModuleService from "../../modules/printTrail/service"
import type { LoadedRow } from "./load-order-for-print-trail"

export type ResolvedTarget = {
  target: SendTarget
  // The number a new row gets unless the orderNumber hook changes it.
  defaultOrderNumber: string | null
  // An existing row's number, which never changes.
  existingOrderNumber: string | null
  // Numbers the order's other rows have.
  takenOrderNumbers: string[]
}

// Which print_trail_order row this run sends (order-scope.ts). A refused
// target ends the run without a Print Trail call; a refused reissue notes
// why on the row it named.
export const resolvePrintTrailTargetStep = createStep(
  "resolve-print-trail-target",
  async (
    input: {
      order: GraphOrder
      rows: LoadedRow[]
      request: { sequence?: number; source_ref?: string; reissue_of?: number }
    },
    { container }
  ) => {
    const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
    const options = await service.getOptions()
    const target = resolveSendTarget(input.rows, input.request)
    if (!target.ok) {
      const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
      logger.warn(`Print Trail: not sending order ${input.order.id}: ${target.reason}`)
      const named = input.rows.find((r) => r.sequence === input.request.reissue_of)
      if (target.reason === "reissue-not-allowed" && named) {
        const team = await service.getState<TeamCodeState>(TEAM_CODE_STATE_KEY)
        await service.createPrintTrailOrderEvents({
          order_id: input.order.id,
          print_trail_order_id: named.id,
          kind: "reopen-refused",
          message: target.detail,
          data: { pt_uuid: named.pt_uuid ?? null, pt_url: printTrailAppUrl(options, team?.teamCode, named.pt_uuid) },
        } as never)
      }
      return new StepResponse<ResolvedTarget>({ target, defaultOrderNumber: null, existingOrderNumber: null, takenOrderNumbers: [] })
    }
    const existing = input.rows.find((r) => r.id === target.rowId)
    return new StepResponse<ResolvedTarget>({
      target,
      defaultOrderNumber: printTrailOrderNumber(options.orderNumberPrefix, input.order.display_id, target.sequence),
      existingOrderNumber: existing?.pt_order_number ?? null,
      takenOrderNumbers: input.rows.filter((r) => r.id !== target.rowId).map((r) => r.pt_order_number),
    })
  }
)
