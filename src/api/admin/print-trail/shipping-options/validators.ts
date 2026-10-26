import { z } from "@medusajs/framework/zod"

// The shape only; the method list and band rules are checked against
// Print Trail's methods in the route (validateRateCard), with every issue
// reported by path.
const Bands = z
  .array(
    z.object({
      max_weight: z.number().positive().nullable(),
      prices: z.record(z.string(), z.number().nonnegative()),
    })
  )
  .min(1)

// Every key of the card must be here: Zod drops the rest, so a key missing
// from this shape is lost on save.
const RateCardInput = z.object({
  method: z.string().min(1),
  currency_code: z.string().regex(/^[a-z]{3}$/i, "Use a three-letter currency code"),
  bands: Bands,
  // Per-country bands, keyed by ISO 3166-1 alpha-2 code; null is not listed.
  countries: z.record(z.string(), Bands.nullable()).nullish(),
})

export const PostPrintTrailShippingOptionSchema = z.object({
  name: z.string().trim().min(1),
  service_zone_id: z.string().min(1),
  shipping_profile_id: z.string().min(1),
  rate_card: RateCardInput,
})
export type PostPrintTrailShippingOptionType = z.infer<typeof PostPrintTrailShippingOptionSchema>

export const UpdatePrintTrailShippingOptionSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    rate_card: RateCardInput.optional(),
  })
  .refine((b) => !!b.name || !!b.rate_card, "Nothing to update")
export type UpdatePrintTrailShippingOptionType = z.infer<typeof UpdatePrintTrailShippingOptionSchema>
