import { MedusaError } from "@medusajs/framework/utils"

export const STAGING_HOST = "https://printtrail-core.consilstaging.com"

export type PrintTrailCredentials = {
  baseUrl?: string
  channelId?: string
  apiToken?: string
}

export type PrintTrailPluginOptions = PrintTrailCredentials & {
  // Optional fallback. Test connection stores the secret the Print Trail API
  // returns from POST /webhooks, and that stored secret wins; this one is
  // used only while none is stored (an older Print Trail API returns none).
  // See src/lib/webhook-secret.ts.
  webhookSecret?: string
  // Public URL of this Medusa backend, for webhook registration.
  backendUrl?: string
  // Medusa admin URL, for the "view in Medusa" link sent to Print Trail.
  adminUrl?: string
  // Print Trail app URL, for links to Print Trail orders. Default: baseUrl
  // with an api. host turned into app.
  appUrl?: string
  // Print Trail orderNumber = prefix + display_id [+ "-n"].
  orderNumberPrefix: string
  defaultShippingMethod: string
  confirmOn: "order.placed" | "payment.captured"
  strictSkus: boolean
  stockSync: { enabled: boolean }
  reconcile: { enabled: boolean; lookbackDays: number }
  autoComplete: boolean
  // Template ids for the per-parcel shipment email and the admin's "cancel too
  // late" email, or false to send none. adminEmail: who gets the admin email
  // (a comma-separated string or a list in the raw options).
  // render: send the plugin's own email as `content` (default true). A
  // template-based provider (SendGrid) prefers `content` over the template,
  // so a store with its own templates there sets it to false.
  notifications: { shipment: string | false; cancelTooLate: string | false; adminEmail: string[]; render: boolean }
  // Default: every location stocking the SKU.
  stockLocationIds?: string[]
}

const clean = (value: string | undefined) => {
  const v = value?.trim()
  return v ? v : undefined
}

const stripSlash = (url: string | undefined) => url?.replace(/\/+$/, "")

// Reads the three credentials once, so medusa-config.ts can pass the same
// values to the plugin and to the fulfilment provider.
export function printTrailOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): PrintTrailCredentials {
  return {
    baseUrl: stripSlash(clean(env.PRINT_TRAIL_BASE_URL)),
    channelId: clean(env.PRINT_TRAIL_CHANNEL_ID),
    apiToken: clean(env.PRINT_TRAIL_API_TOKEN),
  }
}

export function isConnected(o: PrintTrailCredentials): boolean {
  return !!(o.baseUrl && o.channelId && o.apiToken)
}

// The raw plugin options: adminEmail may be one string, split on ",".
export type RawPrintTrailPluginOptions = Omit<Partial<PrintTrailPluginOptions>, "notifications"> & {
  notifications?: {
    // true: on, with the default template id.
    shipment?: string | boolean
    cancelTooLate?: string | boolean
    adminEmail?: string | string[]
    render?: boolean
  }
}

// A template id, false for none; true or unset is the default id.
const templateOf = (value: string | boolean | undefined, fallback: string): string | false =>
  value === false ? false : typeof value === "string" && value.trim() ? value : fallback

const emailList = (value: unknown): string[] => {
  const parts = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : []
  return parts.flatMap((p) => (typeof p === "string" && p.trim() ? [p.trim()] : []))
}

export function resolvePluginOptions(
  raw: RawPrintTrailPluginOptions | Partial<PrintTrailPluginOptions> | undefined
): PrintTrailPluginOptions {
  const o = (raw ?? {}) as RawPrintTrailPluginOptions
  const baseUrl = stripSlash(clean(o.baseUrl))
  const channelId = clean(o.channelId)
  const apiToken = clean(o.apiToken)

  // No default host: a public plugin must never reach production (or staging)
  // unless someone chose it.
  if ((channelId || apiToken) && !baseUrl) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Print Trail API: PRINT_TRAIL_BASE_URL is not set. Use https://api.printtrail.com, " +
        `or ${STAGING_HOST} for staging.`
    )
  }

  return {
    baseUrl,
    channelId,
    apiToken,
    webhookSecret: clean(o.webhookSecret),
    backendUrl: stripSlash(clean(o.backendUrl)),
    adminUrl: stripSlash(clean(o.adminUrl)),
    appUrl: stripSlash(clean(o.appUrl)),
    orderNumberPrefix: o.orderNumberPrefix ?? "",
    defaultShippingMethod: o.defaultShippingMethod ?? "standard",
    confirmOn: o.confirmOn ?? "order.placed",
    strictSkus: o.strictSkus ?? true,
    stockSync: { enabled: o.stockSync?.enabled ?? true },
    reconcile: {
      enabled: o.reconcile?.enabled ?? true,
      lookbackDays: o.reconcile?.lookbackDays ?? 7,
    },
    autoComplete: o.autoComplete ?? true,
    notifications: {
      shipment: templateOf(o.notifications?.shipment, "print-trail-shipment"),
      cancelTooLate: templateOf(o.notifications?.cancelTooLate, "print-trail-cancel-too-late"),
      adminEmail: emailList(o.notifications?.adminEmail),
      render: o.notifications?.render ?? true,
    },
    stockLocationIds: o.stockLocationIds,
  }
}
