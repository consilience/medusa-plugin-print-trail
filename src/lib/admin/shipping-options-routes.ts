import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { PRINT_TRAIL_MODULE } from "../../modules/printTrail"
import type PrintTrailModuleService from "../../modules/printTrail/service"
import type { ShippingOptionView, ValidationIssue } from "../admin-types"
import { PRINT_TRAIL_PROVIDER_ID } from "../lines"
import { guardShippingOptionData, knownMethods, looksLikeRateCard, toShippingOptionView } from "./shipping-options"

export const OPTION_FIELDS = [
  "id",
  "name",
  "price_type",
  "provider_id",
  "data",
  "service_zone.id",
  "service_zone.name",
  "service_zone.fulfillment_set.name",
  "shipping_profile.id",
  "shipping_profile.name",
]

// The methods Print Trail offers, through the short-timeout client so a
// Print Trail outage costs seconds (then the four fallback codes).
export async function methodsFor(scope: MedusaContainer) {
  const service = scope.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  return knownMethods((await service.isConnected()) ? await service.getStatusClient() : null)
}

export async function loadOption(scope: MedusaContainer, id: string): Promise<{ provider_id?: string | null } & Record<string, unknown>> {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({ entity: "shipping_option", fields: OPTION_FIELDS, filters: { id } })
  if (!data[0]) throw new MedusaError(MedusaError.Types.NOT_FOUND, `Shipping option ${id} was not found`)
  return data[0] as never
}

// A Print Trail option, or a 404 (the plugin's routes never touch others).
export async function loadPrintTrailOption(scope: MedusaContainer, id: string) {
  const option = await loadOption(scope, id)
  if (option.provider_id !== PRINT_TRAIL_PROVIDER_ID) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, `Print Trail shipping option ${id} was not found`)
  }
  return option
}

export async function optionView(scope: MedusaContainer, id: string, methods: string[]): Promise<ShippingOptionView> {
  return toShippingOptionView(await loadOption(scope, id), methods)
}

export const invalidCard = (res: MedusaResponse, issues: ValidationIssue[]) =>
  // The JS SDK keeps only `message`, so it lists the issues too.
  res.status(400).json({
    type: "invalid_data",
    message: `Invalid Print Trail rate card: ${issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ")}`,
    issues,
  })

// Guards Medusa's own POST /admin/shipping-options[/:id]: a Print Trail
// option's card must stay valid. On update Medusa merges the body's data
// over the stored data, so the merged card is checked, not the body alone.
// Medusa's own form sends the fulfilment option as data, which passes.
export async function guardCoreShippingOption(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  try {
    const body = ((req as { validatedBody?: unknown }).validatedBody ?? req.body ?? {}) as { provider_id?: unknown; data?: unknown }
    if (body.data === undefined) return next()
    let providerId = typeof body.provider_id === "string" ? body.provider_id : null
    let stored: Record<string, unknown> | null = null
    const id = req.params?.id
    if (id) {
      const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
      const { data } = await query.graph({ entity: "shipping_option", fields: ["id", "provider_id", "data"], filters: { id } })
      providerId ??= (data[0]?.provider_id as string | undefined) ?? null
      stored = (data[0]?.data as Record<string, unknown> | null | undefined) ?? null
    }
    if (providerId !== PRINT_TRAIL_PROVIDER_ID) return next()
    if (!looksLikeRateCard(body.data) && !looksLikeRateCard(stored)) return next()
    const result = guardShippingOptionData({ providerId, data: body.data, stored, methods: (await methodsFor(req.scope)).codes })
    if (!result.ok) return invalidCard(res, result.issues)
    return next()
  } catch (e) {
    return next(e)
  }
}
