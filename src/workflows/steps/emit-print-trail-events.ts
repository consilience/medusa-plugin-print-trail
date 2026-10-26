import { Modules } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import type { PrintTrailEvent } from "../../lib/send-flow"

export const emitPrintTrailEventsStep = createStep(
  "emit-print-trail-events",
  async (events: PrintTrailEvent[], { container }) => {
    if (events.length) {
      const eventBus = container.resolve(Modules.EVENT_BUS)
      await eventBus.emit(events.map((e) => ({ name: e.name, data: e.data })))
    }
    return new StepResponse(events.length)
  }
)
