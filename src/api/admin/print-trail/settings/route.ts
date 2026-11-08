import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { SaveSettingsResult, SettingsView } from "../../../../lib/admin-types"
import { buildSettingsDeps, settingsView } from "../../../../lib/admin/settings"
import { runSettingsSave } from "../../../../lib/admin/settings-save"
import type { SettingValues } from "../../../../lib/settings"
import type { PostPrintTrailSettingsType } from "../validators"

// The settings page's editable settings: each value in force, the config's,
// where it comes from, and who changed it in the admin and when.
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse<SettingsView>) {
  res.json(await settingsView(await buildSettingsDeps(req.scope)))
}

// Saves the given settings over the plugin options. A prefix that could
// repeat an order number already sent, or a switch to confirming when
// placed that would confirm orders waiting for payment, saves nothing until
// confirmed.
export async function POST(req: AuthenticatedMedusaRequest<PostPrintTrailSettingsType>, res: MedusaResponse<SaveSettingsResult>) {
  res.json(
    await runSettingsSave(req.scope, {
      values: req.validatedBody.values as Partial<SettingValues>,
      confirm: req.validatedBody.confirm,
      actor_id: req.auth_context?.actor_id ?? null,
    })
  )
}
