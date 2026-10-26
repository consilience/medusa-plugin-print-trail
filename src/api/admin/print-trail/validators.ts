import { z } from "@medusajs/framework/zod"

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

export const GetAttentionSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
})
export type GetAttentionType = z.infer<typeof GetAttentionSchema>
