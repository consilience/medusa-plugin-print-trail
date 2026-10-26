import { PrintTrailApiError } from "./errors"
import type {
  PtAmendment,
  PtChannel,
  PtConfirmRequest,
  PtCreateOrderRequest,
  PtLinesRequest,
  PtOrder,
  PtShippingMethod,
  PtSkuValidation,
  PtStockLevel,
  PtToken,
} from "./types"

export type PrintTrailClientOptions = {
  baseUrl: string
  channelId: string
  apiToken: string
  fetch?: typeof fetch
  // Delays (ms) before each retry of a 429, 5xx or network failure.
  retryDelays?: number[]
  timeoutMs?: number
  // Called once per request with its final status (after retries); 0 for a
  // network failure. problemType: an error's problem `type` (API 1.2.0's
  // channel-inactive 403 has one), else null. A throwing callback never
  // fails the request.
  onStatus?: (status: number, path: string, problemType?: string | null) => void
  // Called with the trimmed Print-Trail-Api-Version header of every response
  // that carries one, retries included. Never fails the request.
  onApiVersion?: (version: string, path: string) => void
  // Shared by every client of one process: after a 429 with Retry-After,
  // nothing is sent until `until` (epoch ms). Each client has its own if
  // none is given.
  rateLimitGate?: RateLimitGate
}

export type RateLimitGate = { until: number }

// How far a pause may outlast the request's wait budget and still be slept
// off: timer jitter, not a second pause.
const GATE_SLACK_MS = 100

type Raw = { status: number; body: any }

export const DEFAULT_RETRY_DELAYS_MS = [1000, 2000, 4000]
export const DEFAULT_TIMEOUT_MS = 15000
// The admin's status check: no retries and a short timeout, so a hung Print
// Trail answers within seconds.
export const STATUS_CLIENT_TUNING = { retryDelays: [] as number[], timeoutMs: 5000 }

// A Retry-After beyond this is taken as this (a bogus header can't stop the
// plugin for days).
export const MAX_RETRY_AFTER_MS = 3_600_000

// Retry-After as delay-seconds or an HTTP-date; null when absent or unreadable.
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  const v = value?.trim()
  if (!v) return null
  let ms: number
  if (/^\d+$/.test(v)) ms = Number(v) * 1000
  else {
    const at = Date.parse(v)
    if (Number.isNaN(at)) return null
    ms = at - now
  }
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS)
}

const VALIDATE_SKUS_LIMIT = 250
const DETAIL_LIMIT = 300

export type WebhookRegistration = { channel: PtChannel; secret: string | null }

function splitSecret(data: PtChannel): WebhookRegistration {
  const detail = data?.webhookDetail
  if (!detail || typeof detail !== "object") return { channel: data, secret: null }
  const { secret, ...rest } = detail
  return {
    channel: { ...data, webhookDetail: rest },
    secret: typeof secret === "string" && secret ? secret : null,
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// What an error says, for logs, last_error and the admin: the problem's
// detail (or a flat body's message); a validation 422 has neither, only
// violations (API 1.2.0's limits and webhook URL rules among them). A 500's
// reference, which Print Trail support asks for, is quoted by Print Trail's
// generic detail; withReference adds it when the detail doesn't carry it.
function errorDetail(res: Response, parsed: any): string {
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
  const violations = Array.isArray(body?.violations)
    ? (body.violations as unknown[])
        .filter((v): v is { property?: unknown; message: string } => !!v && typeof (v as any).message === "string")
        .map((v) => (typeof v.property === "string" && v.property ? `${v.property}: ${v.message}` : v.message))
    : []
  const text: string =
    (typeof body?.detail === "string" && body.detail) ||
    (typeof body?.message === "string" && body.message) ||
    violations.join("; ") ||
    res.statusText ||
    `HTTP ${res.status}`
  return text
}

const problemTypeOf = (parsed: any): string | null =>
  parsed && typeof parsed === "object" && typeof parsed.type === "string" ? parsed.type : null

// After the length limit, so a long detail never cuts the reference off.
function withReference(detail: string, parsed: any): string {
  const ref = parsed && typeof parsed === "object" && typeof parsed.reference === "string" ? parsed.reference.trim() : ""
  return ref && !detail.includes(ref) ? `${detail} (Print Trail reference ${ref})` : detail
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// Client for the Print Trail API. Envelopes differ per endpoint
// (POST /orders is bare, GET/confirm/cancel wrap in { data }, several are
// flat), so every method unwraps its own; nothing sniffs.
export class PrintTrailClient {
  private readonly fetch_: typeof fetch
  private readonly retryDelays_: number[]
  // The most a request waits between its attempts: the retry delays' sum.
  private readonly waitBudgetMs_: number
  private readonly timeoutMs_: number
  private readonly root_: string
  private readonly origin_: string
  private readonly gate_: RateLimitGate

  constructor(private readonly options: PrintTrailClientOptions) {
    this.fetch_ = options.fetch ?? globalThis.fetch
    this.gate_ = options.rateLimitGate ?? { until: 0 }
    this.retryDelays_ = options.retryDelays ?? DEFAULT_RETRY_DELAYS_MS
    this.waitBudgetMs_ = this.retryDelays_.reduce((a, b) => a + b, 0)
    this.timeoutMs_ = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const base = options.baseUrl.replace(/\/+$/, "")
    this.root_ = `${base}/v1/channels/${encodeURIComponent(options.channelId)}`
    this.origin_ = new URL(base).origin
  }

  async getChannel(): Promise<PtChannel> {
    return (await this.call("GET", "/")).body.data
  }

  async getToken(): Promise<PtToken> {
    return (await this.call("GET", "/token")).body
  }

  async testConnection(): Promise<{ message: string; timestamp: string }> {
    return (await this.call("POST", "/test-connection")).body
  }

  async listShippingMethods(): Promise<PtShippingMethod[]> {
    return (await this.call("GET", "/shipping-methods")).body
  }

  async validateSkus(skus: string[]): Promise<PtSkuValidation> {
    const merged: PtSkuValidation = { results: [], summary: { matched: 0, unknown: 0 } }
    for (let i = 0; i < skus.length; i += VALIDATE_SKUS_LIMIT) {
      const chunk = skus.slice(i, i + VALIDATE_SKUS_LIMIT)
      const part: PtSkuValidation = (
        await this.call("POST", "/products/validate-skus", { skus: chunk })
      ).body
      merged.results.push(...part.results)
      merged.summary.matched += part.summary.matched
      merged.summary.unknown += part.summary.unknown
    }
    return merged
  }

  async stockLevels(): Promise<PtStockLevel[]> {
    return (await this.call("GET", "/stock-levels")).body
  }

  async createOrder(body: PtCreateOrderRequest): Promise<PtOrder> {
    return (await this.call("POST", "/orders", body)).body
  }

  async getOrder(uuid: string): Promise<PtOrder> {
    return (await this.call("GET", `/orders/${encodeURIComponent(uuid)}`)).body.data
  }

  async findOrderByNumber(orderNumber: string): Promise<PtOrder | null> {
    const res = await this.call(
      "GET",
      `/orders?order-number=${encodeURIComponent(orderNumber)}`
    )
    const list: PtOrder[] = res.body.data ?? []
    return list.find((o) => o.orderNumber === orderNumber) ?? null
  }

  // Pages through GET /orders?updated-since=… (inclusive), yielding each page's
  // orders and following links.next verbatim. A next link pointing at another
  // host is never followed (the token would go with it).
  async *ordersUpdatedSincePages(since: string): AsyncGenerator<PtOrder[]> {
    let url: string | null = `${this.root_}/orders?updated-since=${encodeURIComponent(since)}`
    while (url) {
      const res = await this.callUrl("GET", url)
      yield (res.body.data ?? []) as PtOrder[]
      const next: unknown = res.body.links?.next
      url = typeof next === "string" && this.isSameHost(next) ? next : null
    }
  }

  async *listOrdersUpdatedSince(since: string): AsyncGenerator<PtOrder> {
    for await (const page of this.ordersUpdatedSincePages(since)) {
      yield* page
    }
  }

  async confirmOrder(uuid: string, body: PtConfirmRequest): Promise<PtOrder> {
    return (await this.call("PUT", `/orders/${encodeURIComponent(uuid)}/confirm`, body)).body
      .data
  }

  async cancelOrder(uuid: string): Promise<{ status: 200 | 202; order: PtOrder }> {
    const res = await this.call("PUT", `/orders/${encodeURIComponent(uuid)}/cancel`)
    return { status: res.status === 202 ? 202 : 200, order: res.body.data }
  }

  async amendLines(
    uuid: string,
    body: PtLinesRequest
  ): Promise<{ order: PtOrder | null; amendment: PtAmendment }> {
    const res = await this.call("PUT", `/orders/${encodeURIComponent(uuid)}/lines`, body)
    return { order: res.body.data ?? null, amendment: res.body.amendment }
  }

  // The secret comes back apart from the channel, and is removed from it, so
  // no caller holds a channel object that would carry it into a log or a
  // response. null: an older Print Trail API, which returns none.
  async registerWebhook(url: string): Promise<WebhookRegistration> {
    return splitSecret((await this.call("POST", "/webhooks", { url })).body.data)
  }

  // API 1.1.0. Not idempotent: each call makes a new secret (a retried call
  // returns the newest).
  async rotateWebhookSecret(): Promise<WebhookRegistration> {
    return splitSecret((await this.call("POST", "/webhooks/secret/rotate")).body.data)
  }

  private isSameHost(url: string): boolean {
    try {
      return new URL(url).origin === this.origin_
    } catch {
      return false
    }
  }

  private call(method: string, path: string, body?: unknown): Promise<Raw> {
    return this.callUrl(method, `${this.root_}${path === "/" ? "" : path}`, body)
  }

  private async callUrl(method: string, url: string, body?: unknown): Promise<Raw> {
    const path = url.startsWith(this.root_) ? url.slice(this.root_.length) || "/" : url
    let waited = 0
    for (let attempt = 0; ; attempt++) {
      // Print Trail asked for a pause (a 429's Retry-After, maybe heard by
      // another request): wait it out when it fits what's left of this
      // request's wait budget, else fail without sending (notSent), so the
      // caller defers the work without counting an attempt.
      // A timer can fire a little before the clock reaches `until`, so the
      // few milliseconds left after this request's own wait are slept off
      // without counting against the budget.
      const waiting = this.gate_.until - Date.now()
      if (waiting > 0 && (waiting <= GATE_SLACK_MS || waited + waiting <= this.waitBudgetMs_)) {
        waited += waiting
        await sleep(waiting)
      } else if (waiting > 0) {
        this.report(429, path)
        const detail = `Print Trail's rate limit: waiting ${Math.ceil(waiting / 1000)}s before sending again`
        // notSent only while nothing went out: after a sent attempt (a
        // timeout, a 5xx) Print Trail may have seen it, so it counts.
        const notSent = attempt === 0
        throw new PrintTrailApiError(
          `Print Trail API ${method} ${path} ${notSent ? "not sent" : "not retried"}: ${detail}`,
          429,
          null,
          method,
          path,
          detail,
          waiting,
          notSent
        )
      }
      let res: Response | undefined
      let text = ""
      let networkError: unknown
      try {
        res = await this.fetch_(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.options.apiToken}`,
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs_),
        })
        // Inside the same try: the timeout can fire, or the connection drop,
        // while the body is still arriving.
        text = await res.text()
        this.reportVersion(res, path)
      } catch (e) {
        res = undefined
        networkError = e
      }

      const transient = !res || res.status === 429 || res.status >= 500
      const retryAfter = res?.status === 429 ? parseRetryAfter(res.headers?.get("retry-after")) : null
      if (retryAfter !== null) {
        this.gate_.until = Math.max(this.gate_.until, Date.now() + retryAfter)
      }
      // API 1.2.0's 429 says how long to wait. The wait is made here only
      // while the request's waits stay within the retry delays' sum, so a
      // call is never slower than before; a longer one fails the request as
      // transient at once, for the stored retries and the sweep.
      const wait = attempt < this.retryDelays_.length ? Math.max(this.retryDelays_[attempt], retryAfter ?? 0) : null
      if (transient && wait !== null && waited + wait <= this.waitBudgetMs_) {
        waited += wait
        await sleep(wait)
        continue
      }

      if (!res) {
        this.report(0, path)
        const detail = this.redact((networkError as Error)?.message ?? "network error")
        throw new PrintTrailApiError(
          `Print Trail API ${method} ${path} failed: ${detail}`,
          0,
          null,
          method,
          path,
          detail
        )
      }

      let parsed: any = null
      try {
        parsed = text ? JSON.parse(text) : null
      } catch {
        parsed = text
      }
      this.report(res.status, path, problemTypeOf(parsed))

      if (!res.ok) {
        const detail = withReference(this.redact(errorDetail(res, parsed)).slice(0, DETAIL_LIMIT), parsed)
        throw new PrintTrailApiError(
          `Print Trail API ${method} ${path} → ${res.status}: ${detail}`,
          res.status,
          parsed,
          method,
          path,
          detail,
          retryAfter
        )
      }
      return { status: res.status, body: parsed }
    }
  }

  private reportVersion(res: Response, path: string): void {
    try {
      const version = res.headers?.get("print-trail-api-version")?.trim()
      if (version) this.options.onApiVersion?.(version, path)
    } catch {
      // The callback's failure is its own.
    }
  }

  private report(status: number, path: string, problemType: string | null = null): void {
    try {
      this.options.onStatus?.(status, path, problemType)
    } catch {
      // The callback's failure is its own.
    }
  }

  // Never let the token reach a message or a log, even if Print Trail echoes it.
  private redact(text: string): string {
    return text
      .replace(new RegExp(escapeRegExp(this.options.apiToken), "g"), "[redacted]")
      .replace(/Bearer\s+\S+/gi, "[redacted]")
  }
}
