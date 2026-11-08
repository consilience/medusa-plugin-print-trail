import { createStep, createWorkflow, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { MedusaError } from "@medusajs/framework/utils"
import { buildSettingsDeps, saveSettings, type SaveOutcome, type SaveSettingsInput } from "../lib/admin/settings"

export const updatePrintTrailSettingsWorkflowId = "update-print-trail-settings"

export type UpdatePrintTrailSettingsInput = SaveSettingsInput

const updatePrintTrailSettingsStep = createStep(
  "update-print-trail-settings",
  async (input: UpdatePrintTrailSettingsInput, { container }) => {
    const outcome = await saveSettings(await buildSettingsDeps(container), input)
    if (outcome.status === "invalid") {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, outcome.issues.map((i) => `${i.key}: ${i.message}`).join("; "))
    }
    return new StepResponse<Exclude<SaveOutcome, { status: "invalid" }>>(outcome)
  }
)

// Settings → Print Trail: saves settings over the plugin options, or resets
// them to the options, recording who and when. Consumers read them at run
// time (the module service's getOptions). No compensation: a setting
// written is the admin's to change back.
export const updatePrintTrailSettingsWorkflow = createWorkflow(
  updatePrintTrailSettingsWorkflowId,
  function (input: UpdatePrintTrailSettingsInput) {
    const result = updatePrintTrailSettingsStep(input)
    return new WorkflowResponse(result)
  }
)
