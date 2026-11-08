import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import type { SaveSettingsResult } from "../../../../../lib/admin-types"
import { runSettingsSave } from "../../../../../lib/admin/settings-save"
import { isSettingKey } from "../../../../../lib/settings"
import { ResetPrintTrailSettingQuerySchema } from "../../validators"

// Reset: the setting goes back to the plugin options' value. Who reset it,
// and when, is recorded. A reset is checked as a save of the plugin
// options' value would be: a prefix that could repeat an order number
// already sent, or a switch to confirming when placed that would confirm
// orders waiting for payment, resets nothing unless ?confirm= names that
// question (comma-separated reasons).
export async function DELETE(req: AuthenticatedMedusaRequest, res: MedusaResponse<SaveSettingsResult>) {
  const key = req.params.key
  if (!isSettingKey(key)) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, `No Print Trail setting ${key} can be changed in the admin`)
  }
  const query = ResetPrintTrailSettingQuerySchema.safeParse(req.query)
  if (!query.success) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, `confirm must name prefix-may-repeat or confirms-awaiting-payment`)
  }
  res.json(await runSettingsSave(req.scope, { reset: [key], confirm: query.data.confirm, actor_id: req.auth_context?.actor_id ?? null }))
}
