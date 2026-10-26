import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { deleteShippingOptionsWorkflow, updateShippingOptionsWorkflow } from "@medusajs/medusa/core-flows"
import { updateData, validateRateCard } from "../../../../../lib/admin/shipping-options"
import { invalidCard, loadPrintTrailOption, methodsFor, optionView } from "../../../../../lib/admin/shipping-options-routes"
import type { UpdatePrintTrailShippingOptionType } from "../validators"

// Renames an option or replaces its rate card. Print Trail options only.
export async function POST(req: AuthenticatedMedusaRequest<UpdatePrintTrailShippingOptionType>, res: MedusaResponse) {
  const id = req.params.id
  const option = await loadPrintTrailOption(req.scope, id)
  const methods = await methodsFor(req.scope)
  const update: { id: string; name?: string; data?: Record<string, unknown> } = { id }
  if (req.validatedBody.name) update.name = req.validatedBody.name
  if (req.validatedBody.rate_card) {
    const valid = validateRateCard(req.validatedBody.rate_card, methods.codes)
    if (!valid.ok) return invalidCard(res, valid.issues)
    // The new card replaces the stored one, countries included.
    update.data = updateData(option.data as Record<string, unknown> | null, valid.card)
  }
  await updateShippingOptionsWorkflow(req.scope).run({ input: [update] })
  res.json({ shipping_option: await optionView(req.scope, id, methods.codes) })
}

export async function DELETE(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const id = req.params.id
  await loadPrintTrailOption(req.scope, id)
  await deleteShippingOptionsWorkflow(req.scope).run({ input: { ids: [id] } })
  res.json({ id, object: "shipping_option", deleted: true })
}
