import type { PtOrder } from "./types"

type Shortfall = { sku: string; requested: number; available: number }

// API 1.1.0: the create 409's problem types.
export const PROBLEM_TYPES = {
  alreadyConfirmed: "https://docs.printtrail.com/channel-api/problems/order-already-confirmed",
  notUpdatable: "https://docs.printtrail.com/channel-api/problems/order-not-updatable",
  // API 1.2.0: the channel is set inactive in Print Trail; every endpoint
  // answers 403 with this type, and no webhooks are sent.
  channelInactive: "https://docs.printtrail.com/channel-api/problems/channel-inactive",
} as const

// Refusals that no retry and no other request can get past: the token or
// channel ID is wrong (401; an unknown channel is a 401 since API 1.2.0), or
// the channel is inactive. Other 403s (an inactive team, a Standard-channel
// token) have no problem type to tell them apart, so they are plain refusals
// shown with Print Trail's detail.
export type AccessRefusal = "auth-failed" | "channel-inactive"

// For timelines and logs.
export const ACCESS_REFUSED: Record<AccessRefusal, string> = {
  "auth-failed": "Print Trail refused the API token or channel ID",
  "channel-inactive": "The Print Trail channel is inactive",
}

const isRecord = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v)

// Thrown for every non-2xx response and for network failures (status 0).
// Callers in workflow steps turn these into results; they are not meant to
// roll a workflow back.
export class PrintTrailApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    readonly method: string,
    readonly path: string,
    private readonly detail_: string,
    // A 429's Retry-After (ms), or how much of it was left when the client
    // refused to send; null otherwise.
    readonly retryAfterMs: number | null = null,
    // The client refused to send it during a Retry-After pause: Print Trail
    // never saw it, so it must not cost a retry attempt.
    readonly notSent: boolean = false
  ) {
    super(message)
    this.name = "PrintTrailApiError"
  }

  get isChannelInactive(): boolean {
    return this.status === 403 && this.problemType === PROBLEM_TYPES.channelInactive
  }

  get accessRefusal(): AccessRefusal | null {
    if (this.status === 401) return "auth-failed"
    return this.isChannelInactive ? "channel-inactive" : null
  }

  get isTransient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500
  }

  // RFC 7807 problem document. Print Trail's flat bodies (stock 409,
  // strict-SKU 422) and a plain unmatched-route 404 are not.
  get isProblem(): boolean {
    return (
      isRecord(this.body) &&
      typeof this.body.status === "number" &&
      typeof this.body.detail === "string"
    )
  }

  // 409 with a flat { message, errors: [{ sku, requested, available }] } body.
  get stockShortfall(): Shortfall[] | null {
    if (this.status !== 409 || !isRecord(this.body) || !Array.isArray(this.body.errors)) {
      return null
    }
    return this.body.errors as Shortfall[]
  }

  // A problem document's `type` (e.g. PROBLEM_TYPES), or null.
  get problemType(): string | null {
    return this.isProblem && typeof (this.body as Record<string, any>).type === "string"
      ? (this.body as Record<string, any>).type
      : null
  }

  // The typed create 409's extension members (API 1.1.0).
  get orderUuid(): string | null {
    return this.problemString("orderUuid")
  }

  get orderStatus(): string | null {
    return this.problemString("orderStatus")
  }

  // The order a 409 problem carries as `data`: the typed create 409's
  // existing order, or confirm's shipping conflict with the regenerated
  // fulfilment uuids.
  get problemOrder(): PtOrder | null {
    if (this.status !== 409 || !this.isProblem) {
      return null
    }
    const data = (this.body as Record<string, any>).data
    return isRecord(data) && typeof data.uuid === "string" ? (data as PtOrder) : null
  }

  get shippingConflictOrder(): PtOrder | null {
    return this.problemOrder
  }

  private problemString(key: string): string | null {
    const v = this.isProblem ? (this.body as Record<string, any>)[key] : undefined
    return typeof v === "string" && v ? v : null
  }

  // API 1.2.0: a 500's id for the logged error, to quote to Print Trail
  // support. Already in `detail`.
  get reference(): string | null {
    const v = isRecord(this.body) ? this.body.reference : undefined
    return typeof v === "string" && v.trim() ? v.trim() : null
  }

  // A validation 422's { property, message } list (no `detail` on those).
  get violations(): { property: string; message: string }[] {
    if (!isRecord(this.body) || !Array.isArray(this.body.violations)) return []
    return (this.body.violations as unknown[]).flatMap((v) =>
      isRecord(v) && typeof v.message === "string"
        ? [{ property: typeof v.property === "string" ? v.property : "", message: v.message }]
        : []
    )
  }

  get unmatchedSkus(): string[] {
    return isRecord(this.body) && Array.isArray(this.body.unmatchedSkus)
      ? (this.body.unmatchedSkus as string[])
      : []
  }

  get detail(): string {
    return this.detail_
  }
}
