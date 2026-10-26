import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createShippingOptionsWorkflow } from "@medusajs/medusa/core-flows"
import type { ShippingOptionChoices } from "../../../../lib/admin-types"
import { createInput, toShippingOptionView, validateRateCard } from "../../../../lib/admin/shipping-options"
import { invalidCard, methodsFor, OPTION_FIELDS, optionView } from "../../../../lib/admin/shipping-options-routes"
import { PRINT_TRAIL_PROVIDER_ID } from "../../../../lib/lines"
import type { PostPrintTrailShippingOptionType } from "./validators"

// The Print Trail options with their rate cards, and what a new one can use.
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const [options, zones, profiles, methods] = await Promise.all([
    query.graph({ entity: "shipping_option", fields: OPTION_FIELDS, filters: { provider_id: PRINT_TRAIL_PROVIDER_ID } }),
    query.graph({ entity: "service_zone", fields: ["id", "name", "fulfillment_set.name"] }),
    query.graph({ entity: "shipping_profile", fields: ["id", "name"] }),
    methodsFor(req.scope),
  ])
  const choices: ShippingOptionChoices = {
    service_zones: zones.data.map((z) => ({
      id: z.id as string,
      name: z.name as string,
      location: ((z as { fulfillment_set?: { name?: string } | null }).fulfillment_set?.name as string | undefined) ?? null,
    })),
    shipping_profiles: profiles.data.map((p) => ({ id: p.id as string, name: p.name as string })),
    methods,
  }
  res.json({ shipping_options: options.data.map((o) => toShippingOptionView(o, methods.codes)), choices })
}

// Creates a calculated Print Trail option with its rate card, through
// Medusa's own workflow.
export async function POST(req: AuthenticatedMedusaRequest<PostPrintTrailShippingOptionType>, res: MedusaResponse) {
  const methods = await methodsFor(req.scope)
  const valid = validateRateCard(req.validatedBody.rate_card, methods.codes)
  if (!valid.ok) return invalidCard(res, valid.issues)
  const { result } = await createShippingOptionsWorkflow(req.scope).run({
    input: [createInput(req.validatedBody, valid.card)],
  })
  res.json({ shipping_option: await optionView(req.scope, result[0].id, methods.codes) })
}
