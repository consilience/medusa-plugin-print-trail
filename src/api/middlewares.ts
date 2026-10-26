import { defineMiddlewares, validateAndTransformBody, validateAndTransformQuery } from "@medusajs/framework/http"
import { guardCoreShippingOption } from "../lib/admin/shipping-options-routes"
import {
  PostPrintTrailShippingOptionSchema,
  UpdatePrintTrailShippingOptionSchema,
} from "./admin/print-trail/shipping-options/validators"
import {
  GetAttentionSchema,
  PostPrintTrailDismissSchema,
  PostPrintTrailResendSchema,
  PostPrintTrailStockSyncSchema,
  PostPrintTrailWebhookSchema,
} from "./admin/print-trail/validators"

export default defineMiddlewares({
  routes: [
    {
      // The HMAC is computed over the raw bytes. `methods` (plural): the
      // 2.17.2 loader ignores the deprecated `method` for bodyParser.
      matcher: "/hooks/print-trail",
      methods: ["POST"],
      bodyParser: { preserveRawBody: true },
    },
    {
      matcher: "/admin/print-trail/webhook",
      methods: ["POST"],
      middlewares: [validateAndTransformBody(PostPrintTrailWebhookSchema)],
    },
    {
      matcher: "/admin/print-trail/shipping-options",
      methods: ["POST"],
      middlewares: [validateAndTransformBody(PostPrintTrailShippingOptionSchema)],
    },
    {
      matcher: "/admin/print-trail/shipping-options/:id",
      methods: ["POST"],
      middlewares: [validateAndTransformBody(UpdatePrintTrailShippingOptionSchema)],
    },
    {
      matcher: "/admin/print-trail/orders/:id/resend",
      methods: ["POST"],
      middlewares: [validateAndTransformBody(PostPrintTrailResendSchema)],
    },
    {
      matcher: "/admin/print-trail/orders/:id/dismiss",
      methods: ["POST"],
      middlewares: [validateAndTransformBody(PostPrintTrailDismissSchema)],
    },
    {
      matcher: "/admin/print-trail/stock-sync",
      methods: ["POST"],
      middlewares: [validateAndTransformBody(PostPrintTrailStockSyncSchema)],
    },
    {
      matcher: "/admin/print-trail/attention",
      methods: ["GET"],
      middlewares: [validateAndTransformQuery(GetAttentionSchema, { defaults: [], isList: true })],
    },
    {
      // Rate cards edited through Medusa's own routes are validated too.
      matcher: "/admin/shipping-options",
      methods: ["POST"],
      middlewares: [guardCoreShippingOption],
    },
    {
      matcher: "/admin/shipping-options/:id",
      methods: ["POST"],
      middlewares: [guardCoreShippingOption],
    },
  ],
})
