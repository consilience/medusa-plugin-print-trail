import type { MedusaContainer } from "@medusajs/framework/types"
import { updatePrintTrailSettingsWorkflow } from "../../workflows/update-print-trail-settings"
import type { SaveSettingsResult, SettingKeyDto } from "../admin-types"
import { buildSettingsDeps, settingsView, type SaveSettingsInput } from "./settings"

// A save or reset through the workflow, as the settings routes answer it:
// the outcome, with the view after a save.
export async function runSettingsSave(scope: MedusaContainer, input: SaveSettingsInput): Promise<SaveSettingsResult> {
  const { result } = await updatePrintTrailSettingsWorkflow(scope).run({ input })
  if (result.status === "needs-confirmation") return result
  return {
    status: "saved",
    keys: result.keys as SettingKeyDto[],
    warnings: result.warnings,
    view: await settingsView(await buildSettingsDeps(scope)),
  }
}
