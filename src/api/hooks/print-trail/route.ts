import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { handlePrintTrailWebhook } from "../../../lib/webhook"
import { readWebhookSecrets } from "../../../lib/webhook-secret"
import { PRINT_TRAIL_MODULE } from "../../../modules/printTrail"
import type PrintTrailModuleService from "../../../modules/printTrail/service"

// Print Trail's signed webhooks. No authenticate middleware: /hooks is outside
// Medusa's protected prefixes and the HMAC is the authentication. Replies 202
// once the event is queued; the subscriber re-fetches the order.
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const service = req.scope.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  const eventBus = req.scope.resolve(Modules.EVENT_BUS)
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const options = await service.getOptions()
  // One indexed read per delivery, so a secret stored by Test connection or a
  // rotation in another process applies at once.
  const { secrets } = await readWebhookSecrets(service, options, new Date())
  const header = req.headers["signature"]
  const reply = await handlePrintTrailWebhook(
    { rawBody: req.rawBody, signature: Array.isArray(header) ? header[0] : header },
    {
      secrets,
      emit: (msg) => eventBus.emit(msg),
      find: {
        byUuid: async (uuid) => ((await service.listPrintTrailOrders({ pt_uuid: uuid }))[0] as never) ?? null,
        byNumber: async (n) => (await service.listPrintTrailOrders({ pt_order_number: n })) as never,
      },
      logger,
    }
  )
  res.status(reply.status).json(reply.body)
}
