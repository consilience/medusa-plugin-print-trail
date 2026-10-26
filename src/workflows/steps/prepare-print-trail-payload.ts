import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { acceptOrderNumber, preparePayload, type PreparedPayload } from "../../lib/hooks"
import type { GraphOrder, SelectedLine } from "../../lib/lines"
import { PRINT_TRAIL_MODULE } from "../../modules/printTrail"
import type PrintTrailModuleService from "../../modules/printTrail/service"
import type { ResolvedTarget } from "./resolve-print-trail-target"

// Settles the order number (an existing row keeps its own; a new row takes
// the orderNumber hook's value when usable) and builds the payload the
// payload hook then sees.
export const preparePrintTrailPayloadStep = createStep(
  "prepare-print-trail-payload",
  async (
    input: { order: GraphOrder; lines: SelectedLine[]; resolved: ResolvedTarget; hookOrderNumber?: unknown },
    { container }
  ) => {
    const { resolved } = input
    if (!resolved.target.ok || !resolved.defaultOrderNumber) {
      return new StepResponse<{ orderNumber: string | null; prepared: PreparedPayload | null }>({ orderNumber: null, prepared: null })
    }
    let orderNumber = resolved.existingOrderNumber
    if (!orderNumber) {
      const accepted = acceptOrderNumber(input.hookOrderNumber, resolved.defaultOrderNumber, resolved.takenOrderNumbers)
      if (accepted.warning) {
        container.resolve(ContainerRegistrationKeys.LOGGER).warn(`Print Trail: order ${input.order.id}: ${accepted.warning}`)
      }
      orderNumber = accepted.orderNumber
    }
    const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
    const prepared = preparePayload({ order: input.order, lines: input.lines, orderNumber, options: await service.getOptions() })
    return new StepResponse<{ orderNumber: string | null; prepared: PreparedPayload | null }>({ orderNumber, prepared })
  }
)
