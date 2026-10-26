// The views the admin API returns. Types only and no imports, so the admin
// bundle can `import type` this file. The DTOs are structural copies of the
// server types (the connection-decisions test checks they stay assignable).

export type Masked = { set: boolean; ending: string | null }

export type DiagnosisCode =
  | "not-configured"
  | "token-invalid"
  | "channel-inactive"
  | "channel-not-found"
  | "not-print-trail"
  | "token-other-channel"
  | "unreachable"
  | "error"

export type Diagnosis =
  | { ok: true; teamCode: string; channelCode: string; channelId: string }
  | { ok: false; code: DiagnosisCode; detail?: string; tokenChannelId?: string }

export type WebhookState = "registered" | "not-registered" | "elsewhere" | "unknown" | "no-backend-url"
// too-long, credentials and fragment: never accepted (API 1.2.0); the others
// are registered only after a confirm.
// undeliverable: registered, but Print Trail (1.2.0+) won't deliver to it.
export type WebhookWarning = "not-https" | "local-address" | "too-long" | "credentials" | "fragment" | "undeliverable"
// busy: another connection check holds the webhook-secret lock.
// invalid-url: refused before asking Print Trail (see WebhookWarning).
export type WebhookAction =
  | "registered"
  | "already-registered"
  | "needs-confirmation"
  | "cannot-register"
  | "invalid-url"
  | "failed"
  | "busy"

export type SettingsWarning =
  | "not-configured"
  | "no-webhook-secret"
  | "webhook-secret-mismatch"
  | "no-backend-url"
  | "no-admin-url"
  | "no-admin-email"
  | "in-memory-locking"
  | "postgres-locking"
  | "postgres-locking-configured"
  | "no-print-trail-shipping-options"

// reconnect: Print Trail refused the token or channel ID (auth_failed);
// channelInactive: the channel is inactive (API 1.2.0, channel_inactive).
export type HealthView = { reconnect: boolean; channelInactive: boolean; unmatchedSkus: number }
export type EndpointView = { url: string | null; environment: "staging" | "production" | "other" | null }
export type LockingView = { provider: "in-memory" | "redis" | "postgres" | "other"; postgresConfigured: boolean; supported: boolean }

export type RateBandDto = { max_weight: number | null; prices: Record<string, number> }
export type RateCardDto = {
  method: string
  currency_code: string
  bands: RateBandDto[]
  // Per-country bands, by lower-case ISO 3166-1 alpha-2 code; absent when
  // the card has none.
  countries?: Record<string, RateBandDto[]>
}
export type SkuCheckDto = { sku: string | null; status: string; checked_at: string; matched_sku?: string; note?: string }
export type SendInputDto = { order_id: string; sequence?: number; source_ref?: string; reissue_of?: number }

export type ScheduleViewDto = { job: string; variable: string; schedule: string; isDefault: boolean }

export type ConnectionView = {
  configured: boolean
  endpoint: EndpointView
  // webhookSecret.source: "print-trail" (returned by POST /webhooks and
  // stored), "configured" (PRINT_TRAIL_WEBHOOK_SECRET, the fallback) or null.
  credentials: {
    channelId: string | null
    apiToken: Masked
    webhookSecret: Masked & { source: "print-trail" | "configured" | null }
  }
  diagnosis: Diagnosis
  channel: { name: string | null; code: string; url: string | null } | null
  team: { name: string | null; code: string; url: string | null } | null
  webhook: { state: WebhookState; registeredUrl: string | null; targetUrl: string | null; warnings: WebhookWarning[] }
  shippingMethods: { code: string; name: string }[]
  shippingMethodsSource: "print-trail" | "fallback"
  options: {
    orderNumberPrefix: string
    defaultShippingMethod: string
    confirmOn: string
    strictSkus: boolean
    stockSync: boolean
    reconcile: { enabled: boolean; lookbackDays: number }
    autoComplete: boolean
    notifications: { shipment: string | false; cancelTooLate: string | false; adminEmailCount: number }
    stockLocationIds: string[] | null
    appUrl: string | null
    adminUrl: string | null
    backendUrl: string | null
  }
  locking: LockingView | null
  schedules: ScheduleViewDto[]
  warnings: SettingsWarning[]
  health: HealthView
  // The Print-Trail-Api-Version last heard, or null (an older Print Trail
  // API, or no call yet). Shown only; never gates behaviour.
  api_version: { version: string; seen_at: string } | null
}

export type ConnectionTestResult = {
  diagnosis: Diagnosis
  // registeredUrl: where Print Trail sends now, when that is elsewhere.
  webhook: { action: WebhookAction; state: WebhookState; warnings: WebhookWarning[]; detail?: string; registeredUrl?: string }
}

// "Rotate webhook secret". not-registered: the channel doesn't send to this
// store, so rotating would break whoever it sends to. unsupported: an older
// Print Trail API without the rotate route.
export type RotateResult = { action: "rotated" | "not-registered" | "unsupported" | "failed" | "busy"; detail?: string }

export type ShippingOptionView = {
  id: string
  name: string
  service_zone: { id: string; name: string; location: string | null } | null
  shipping_profile: { id: string; name: string } | null
  price_type: string
  rate_card: RateCardDto | null
  card_issue: "missing" | "invalid" | null
}

export type ShippingOptionChoices = {
  service_zones: { id: string; name: string; location: string | null }[]
  shipping_profiles: { id: string; name: string }[]
  methods: { codes: string[]; source: "print-trail" | "fallback" }
}

export type ValidationIssue = { path: string; message: string }

export type FulfilmentView = {
  uuid: string
  number: string | null
  location: string | null
  productionMethod: string | null
  status: string
  shippingMethod: string | null
  tracking: { number: string; url: string | null; carrier: string | null }[]
  // Print Trail API 1.3.0: why a back-order waits (pre-order: for the release),
  // and the latest publication date among its lines.
  back_order: "pre-order" | "out-of-stock" | "warehouse" | null
  // Waiting for release with a line whose product was set inactive.
  product_inactive: boolean
  publication_date: string | null
}

export type OrderRowView = {
  id: string
  sequence: number
  source_ref: string | null
  pt_order_number: string
  pt_uuid: string | null
  pt_url: string | null
  status: string | null
  fulfillable_status: string | null
  confirmed_at: string | null
  block_reason: string | null
  last_error: string | null
  attention: string | null
  pending_action: string | null
  next_attempt_at: string | null
  cancel_status: string | null
  held_lines: number
  fulfilments: FulfilmentView[]
  cancel_warning: FulfilmentView[] | null
  actions: { refresh: boolean; resend: boolean; resend_as_new: boolean; dismiss: boolean }
}

export type TimelineEntry = {
  id: string
  at: string
  kind: string
  message: string
  pt_order_number: string | null
  pt_url: string | null
}

export type OrderView = {
  order_id: string
  display_id: number | null
  canceled: boolean
  expected: boolean
  rows: OrderRowView[]
  timeline: TimelineEntry[]
  health: HealthView
  // What "Resend as a new Print Trail order" would be numbered (the
  // orderNumber hook may still change it).
  next_pt_order_number: string | null
}

export type ResendRefusal =
  | "already-confirmed"
  | "cancelled-in-medusa"
  | "print-trail-cancelled"
  | "not-cancelled-at-print-trail"
  | "already-reissued"
  | "order-canceled"

export type RefreshResult = { changed: boolean; rows: { id: string; outcome: string; changes: number }[] }
export type ResendResult = {
  plan: "send" | "reissue" | "cancel" | "amend" | "refetch" | "refused"
  status: "done" | "busy" | "refused"
  reason?: string
  // For a send or reissue: what the send run actually did.
  outcome?: "confirmed" | "not-confirmed" | "blocked" | "retrying" | "held" | "not-sent"
}
export type DismissResult = { status: "dismissed" | "unchanged" | "busy" }

export type AttentionRow = {
  id: string
  order_id: string
  display_id: number | null
  pt_order_number: string
  pt_url: string | null
  attention: string
  last_error: string | null
  updated_at: string
  dismissable: boolean
}

export type AttentionList = { rows: AttentionRow[]; count: number; limit: number; offset: number; health: HealthView }

export type SkuProblem = {
  variant_id: string
  product_id: string
  product_title: string | null
  variant_title: string | null
  sku: string | null
  status: string
  checked_at: string | null
}

export type StockRunView = {
  trigger: string
  completedAt: string | null
  levelsUpdated: number
  skipped: { variantId: string; reason: string }[]
  warnings: { type: string; skus: string[] }[]
  error: string | null
}

export type SkuHealthView = {
  unmatched: string[]
  problems: SkuProblem[]
  unchecked: number
  truncated: boolean
  lastRun: StockRunView | null
  stockSyncEnabled: boolean
}

export type VariantView = {
  in_print_trail_profile: boolean
  sku: string | null
  override: string | null
  resolved_sku: string | null
  check: SkuCheckDto | null
  check_current: boolean
  stock: {
    manage_inventory: boolean
    allow_backorder: boolean
    available: number | null
    print_on_demand: boolean
    // On pre-order at Print Trail (API 1.3.0).
    pre_order: boolean
    // The plugin turned backorders on because it's pre-order.
    pre_order_backorder: boolean
    pre_order_limit: number | null
    pre_order_remaining: number | null
    publication_date: string | null
  }
}
