import { z } from "@medusajs/framework/zod"
import { CONFIRM_REASONS, SETTING_SCHEMAS } from "../../../lib/settings"

// Settings → Print Trail. A key left out is unchanged; "" for the prefix is
// an empty prefix. Strict: credentials and deployment URLs (or any other
// key) can't be written here. confirm: the questions the admin answered yes
// to, each by the reason a needs-confirmation answer gave (a prefix that
// could repeat an order number already sent; a switch to confirming when
// placed that confirms orders waiting for payment).
export const PostPrintTrailSettingsSchema = z
  .object({
    values: z
      .object({
        orderNumberPrefix: SETTING_SCHEMAS.orderNumberPrefix.optional(),
        defaultShippingMethod: SETTING_SCHEMAS.defaultShippingMethod.optional(),
        confirmOn: SETTING_SCHEMAS.confirmOn.optional(),
        strictSkus: SETTING_SCHEMAS.strictSkus.optional(),
        "stockSync.enabled": SETTING_SCHEMAS["stockSync.enabled"].optional(),
        "reconcile.enabled": SETTING_SCHEMAS["reconcile.enabled"].optional(),
        "reconcile.lookbackDays": SETTING_SCHEMAS["reconcile.lookbackDays"].optional(),
        autoComplete: SETTING_SCHEMAS.autoComplete.optional(),
        "notifications.shipment": SETTING_SCHEMAS["notifications.shipment"].optional(),
        "notifications.cancelTooLate": SETTING_SCHEMAS["notifications.cancelTooLate"].optional(),
        "notifications.adminEmail": SETTING_SCHEMAS["notifications.adminEmail"].optional(),
        stockLocationIds: SETTING_SCHEMAS.stockLocationIds.optional(),
      })
      .strict(),
    confirm: z.array(z.enum(CONFIRM_REASONS)).max(CONFIRM_REASONS.length).optional().default([]),
  })
  .strict()
export type PostPrintTrailSettingsType = z.infer<typeof PostPrintTrailSettingsSchema>

// DELETE …/settings/:key: ?confirm=<reason>[,<reason>].
export const ResetPrintTrailSettingQuerySchema = z
  .object({
    confirm: z
      .string()
      .optional()
      .transform((s) => (s ? s.split(",") : []))
      .pipe(z.array(z.enum(CONFIRM_REASONS)).max(CONFIRM_REASONS.length)),
  })
  .strict()

export const PostPrintTrailWebhookSchema = z.object({ force: z.boolean().optional().default(false) })
export type PostPrintTrailWebhookType = z.infer<typeof PostPrintTrailWebhookSchema>

export const PostPrintTrailResendSchema = z.object({
  print_trail_order_id: z.string().min(1).optional(),
  as_new: z.boolean().optional().default(false),
})
export type PostPrintTrailResendType = z.infer<typeof PostPrintTrailResendSchema>

export const PostPrintTrailDismissSchema = z.object({
  print_trail_order_id: z.string().min(1),
  attention: z.string().min(1),
})
export type PostPrintTrailDismissType = z.infer<typeof PostPrintTrailDismissSchema>

// "Sync stock now" takes no body: always a full sync.
export const PostPrintTrailStockSyncSchema = z.object({}).strict()
export type PostPrintTrailStockSyncType = z.infer<typeof PostPrintTrailStockSyncSchema>

export const GetAttentionSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
})
export type GetAttentionType = z.infer<typeof GetAttentionSchema>
