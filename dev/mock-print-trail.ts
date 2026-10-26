// In-memory Print Trail API for tests and local development.
//
//   node dev/mock-print-trail.ts          listens on PORT (default 4010)
//
// Point a store at it with PRINT_TRAIL_BASE_URL=http://127.0.0.1:4010 (not localhost),
// PRINT_TRAIL_CHANNEL_ID=test-channel and PRINT_TRAIL_API_TOKEN=$PT_TOKEN
// (default "dev-token"). It mirrors the Print Trail API's envelopes and error
// bodies, including API 1.1.0 (the webhook secret from register, the rotate
// route, confirmedAt, the typed create 409), API 1.1.1's not-updatable for a
// once-confirmed finished order, and API 1.2.0's hardening (an unknown
// channel is a 401, inactive channels and teams, the webhook URL rules and
// the input limits); `legacy` (or state.legacy) behaves like the Print Trail
// API before them. With `preOrderRelease` (default: on unless legacy) it
// also behaves like API 1.3.0 (pre-order products, on production since
// 2026-10-20): pre-order lines are held as back-orders and released.
// Self-contained: no imports from src, so Node can run it with type stripping
// alone.
import http from "node:http"
import { createHmac, randomBytes, randomUUID } from "node:crypto"
import type { AddressInfo } from "node:net"

export type MockOptions = {
  port?: number
  token?: string
  channelId?: string
  // SKU → stock. 10000 or more is print-on-demand.
  skus?: Record<string, number>
  // SKU → supplier location code; lines are split into one fulfilment per location.
  locations?: Record<string, string>
  // Location code → shipping codes its fulfilments offer (default: all four).
  methodsByLocation?: Record<string, string[]>
  // The channel's webhook secret: the key for the Signature header on webhooks
  // the mock sends, and what POST /webhooks returns (default "mock-secret").
  webhookSecret?: string
  // Behave like the Print Trail API before 1.1.0: no secret from POST
  // /webhooks, no rotate route, no confirmedAt key, and a generic create 409
  // with no order.
  legacy?: boolean
  // SKU → product status validate-skus reports for a match (default "active").
  skuStatus?: Record<string, SkuStatus>
  // API 1.3.0 (pre-order products). Default: on unless legacy.
  preOrderRelease?: boolean
  // API 1.2.0 refuses a webhook URL that isn't https on a public host. The
  // mock only ever serves development and tests, whose stores listen on
  // http://localhost, so by default it accepts a plain-http or local URL
  // (as a development Print Trail set to allow private hosts does for the
  // host, though it keeps https required). The length, credentials and fragment
  // rules always apply. false: production's rules (except DNS, which the mock
  // never looks up), for registration and every delivery. Default true.
  allowLocalWebhooks?: boolean
  // API 1.2.0: the channel is inactive (403 channel-inactive on every
  // endpoint, no webhooks), or the team is (403 on create, amend, confirm
  // and webhook registration). Default false.
  channelInactive?: boolean
  teamInactive?: boolean
  // SKU → publication date (YYYY-MM-DD).
  publicationDate?: Record<string, string>
  // SKU → pre-order limit (applies only while the SKU is pre-order).
  preOrderLimit?: Record<string, number>
  // The warehouse allows back-orders: a confirm short of stock gives an
  // out-of-stock back-order instead of a 409 (API 1.3.0). Default false.
  backorderWarehouse?: boolean
}

export type SkuStatus = "active" | "inactive" | "pre-order"

type Failure = { path: RegExp; status: number; body?: unknown; times: number; headers?: Record<string, string> }

export type MockPrintTrail = {
  url: string
  state: {
    orders: Map<string, any>
    stock: Record<string, number>
    skuStatus: Record<string, SkuStatus>
    // GET /stock-levels appends this many { sku: null } rows, as Print Trail
    // can for products with no public SKU.
    nullSkuRows: number
    webhookUrl: string | null
    requests: { method: string; path: string; body: any }[]
    // fulfillableStatus a new draft gets from POST /orders (default "fulfillable").
    createFulfillableStatus: string
    // An older Print Trail API (see MockOptions.legacy); settable per test.
    legacy: boolean
    // The secret the mock signs with now; POST /webhooks/secret/rotate replaces it.
    webhookSecret: string
    // API 1.3.0. Reads !legacy until a test sets it; reset() clears that.
    preOrderRelease: boolean
    publicationDate: Record<string, string>
    preOrderLimit: Record<string, number>
    backorderWarehouse: boolean
    // The Print-Trail-Api-Version header: "1.3.0" with preOrderRelease,
    // "1.2.0" without, none (null) in legacy, until a test sets it.
    apiVersion: string | null
    // API 1.2.0 (see MockOptions); settable per test.
    allowLocalWebhooks: boolean
    channelInactive: boolean
    teamInactive: boolean
  }
  // Back to the start: no orders, requests, failures or webhook URL, and the
  // stock and SKU statuses the mock was started with.
  reset(): void
  // headers: e.g. a 429's Retry-After and X-RateLimit-*.
  fail(path: RegExp, status: number, body?: unknown, times?: number, headers?: Record<string, string>): void
  // Posts a signed webhook to opts.url (default: the registered URL) and
  // returns the receiver's reply. signature and body override what's sent.
  // As API 1.2.0, nothing is sent (status 0) to an inactive channel, or to a
  // URL the webhook rules refuse.
  sendWebhook(
    type: string,
    orderUuid?: string,
    opts?: { url?: string; secret?: string; signature?: string; extra?: object; body?: string }
  ): Promise<{ status: number; body: unknown }>
  // What Print Trail's own app and production do to an order. Each one moves
  // updatedAt, as Print Trail does.
  setStatus(uuid: string, status: string, fulfillableStatus?: string): void
  cancelFulfilment(uuid: string, index: number): void
  setShippingMethod(uuid: string, index: number, code: string): void
  // The app's full edit: back to draft, fulfilments dropped, lines kept.
  fullEdit(uuid: string): void
  // The app's copy: a new draft numbered `${orderNumber}-COPY`. Returns its uuid.
  copy(uuid: string): string
  dispatch(uuid: string, fulfilmentIndex?: number, opts?: { tracking?: boolean }): void
  addTracking(uuid: string, fulfilmentIndex: number): void
  setUpdatedAt(uuid: string, iso: string): void
  // Resolves a cancel that got 202 (order "processing"), as Print Trail's async
  // cancel does. cancelled: the order and every fulfilment; dispatched: every
  // fulfilment dispatched with tracking, order complete; partial: fulfilment
  // 0 dispatched with tracking, the rest cancelled, order cancelled.
  settleCancel(uuid: string, outcome: "cancelled" | "dispatched" | "partial"): void
  // API 1.3.0. A product's status (and publication date) changes, or its
  // stock does: held back-orders are released, oldest first, where every
  // product is active and stock covers every line; one stock-level-updated
  // follows. Also POST /__mock/products/{sku} { status?, publicationDate?, stock? }.
  setSkuStatus(sku: string, status: SkuStatus, publicationDate?: string | null): Promise<void>
  restock(sku: string, stock: number): Promise<void>
  // The warehouse accepts a fulfilment (sentToWarehouseAt); with backOrder it
  // then reports it as a back-order (reason "warehouse").
  sendToWarehouse(uuid: string, fulfilmentIndex: number, opts?: { backOrder?: boolean }): void
  close(): Promise<void>
}

const METHODS = [
  { code: "standard", name: "Standard" },
  { code: "express", name: "Express (Tracked)" },
  { code: "air", name: "Air Express (Tracked)" },
  { code: "tracked", name: "Tracked" },
]
const CODES = METHODS.map((m) => m.code)
const PAGE = 20

const PROBLEMS = "https://docs.printtrail.com/channel-api/problems/"

// Print Trail's validation 422: violations, no detail.
const violations = (list: { property: string; message: string }[]) => ({
  type: "about:blank",
  status: 422,
  title: "Validation errors",
  violations: list,
})

const MAX_LENGTH = 255
const MAX_ORDER_LINES = 500
const MAX_WEBHOOK_URL = 200

const INTERNAL_SUFFIXES = [".localhost", ".internal", ".local"]

// Print Trail's webhook URL check (API 1.2.0), without DNS: why a URL is
// refused, or null. allowLocal skips the scheme and host checks.
export function webhookUrlRefusal(url: unknown, allowLocal: boolean): string | null {
  if (typeof url !== "string" || !url) return "The url field is required."
  if ([...url].length > MAX_WEBHOOK_URL) return "The webhook URL may not be longer than 200 characters."
  const notAllowed = (why: string) => `The url is not allowed: ${why} Webhook URLs must be https on a public host.`
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return notAllowed("The webhook URL must be a valid absolute URL without a fragment.")
  }
  if (u.hash || url.includes("#")) return notAllowed("The webhook URL must be a valid absolute URL without a fragment.")
  if (u.username || u.password) return notAllowed("The webhook URL must not contain a user name or password.")
  if (allowLocal) return null
  if (u.protocol !== "https:") return notAllowed("The webhook URL must use https.")
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")
  if (/^[\d.]+$/.test(host) || host.includes(":")) {
    if (!publicAddress(host)) return notAllowed(`The webhook host "${host}" resolves to a non-public address; it must be a public host.`)
    return null
  }
  if (!host.includes(".") || host === "localhost" || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) {
    return notAllowed(`The webhook host "${host}" is an internal name; it must be a public host.`)
  }
  return null
}

function publicAddress(ip: string): boolean {
  if (ip.includes(":")) {
    const v = ip.toLowerCase()
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return publicAddress(mapped[1])
    const first = parseInt(v.split(":")[0] || "0", 16)
    return !(v === "::1" || v === "::" || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00)
  }
  const [a, b] = ip.split(".").map(Number)
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  )
}

const problem = (status: number, title: string, detail: string, extra: object = {}) => ({
  type: "about:blank",
  title,
  status,
  detail,
  ...extra,
})

export function startMockPrintTrail(opts: MockOptions = {}): Promise<MockPrintTrail> {
  const token = opts.token ?? "dev-token"
  const channelId = opts.channelId ?? "test-channel"
  const [teamCode, ...rest] = channelId.split("-")
  const channelCode = rest.join("-") || "channel"
  const locations = opts.locations ?? {}
  const methodsByLocation = opts.methodsByLocation ?? {}

  // 9780000000026 is print-on-demand with 3 in the warehouse.
  const startStock = opts.skus ?? { "9780000000002": 25, "9780000000019": 0, "9780000000026": 10003 }
  // Settable overrides of the derived defaults (undefined: derived).
  let preOrderReleaseSet: boolean | undefined
  let apiVersionSet: string | null | undefined
  const state = {
    orders: new Map(),
    stock: { ...startStock },
    skuStatus: { ...(opts.skuStatus ?? {}) },
    nullSkuRows: 0,
    webhookUrl: null,
    requests: [],
    createFulfillableStatus: "fulfillable",
    legacy: opts.legacy ?? false,
    webhookSecret: opts.webhookSecret ?? "mock-secret",
    publicationDate: { ...(opts.publicationDate ?? {}) },
    preOrderLimit: { ...(opts.preOrderLimit ?? {}) },
    backorderWarehouse: opts.backorderWarehouse ?? false,
    allowLocalWebhooks: opts.allowLocalWebhooks ?? true,
    channelInactive: opts.channelInactive ?? false,
    teamInactive: opts.teamInactive ?? false,
    get preOrderRelease(): boolean {
      return preOrderReleaseSet ?? opts.preOrderRelease ?? !state.legacy
    },
    set preOrderRelease(v: boolean) {
      preOrderReleaseSet = v
    },
    get apiVersion(): string | null {
      if (apiVersionSet !== undefined) return apiVersionSet
      if (state.preOrderRelease) return "1.3.0"
      return state.legacy ? null : "1.2.0"
    },
    set apiVersion(v: string | null) {
      apiVersionSet = v
    },
  } as MockPrintTrail["state"]
  const failures: Failure[] = []
  // Every order keeps confirmedAt in state, as Print Trail does: set on the
  // first confirm, cleared only with a move back to draft. Legacy mode leaves
  // the key out of what it sends (see json()).

  const statusOf = (sku: string): SkuStatus =>
    Object.entries(state.skuStatus).find(([k]) => k.toLowerCase() === sku.toLowerCase())?.[1] ?? "active"

  const publicationOf = (sku: string): string | null =>
    Object.entries(state.publicationDate).find(([k]) => k.toLowerCase() === sku.toLowerCase())?.[1] ?? null

  const findSku = (sku: string | undefined) =>
    Object.keys(state.stock).find((k) => k.toLowerCase() === (sku ?? "").toLowerCase())

  // POST /webhooks and the rotate route add the secret (API 1.1.0); no other
  // response carries it.
  const withSecret = () => {
    const c: any = channel()
    if (!state.legacy) c.webhookDetail = { ...c.webhookDetail, secret: state.webhookSecret }
    return c
  }

  const channel = () => ({
    id: 1,
    name: "Test channel",
    state: "active",
    mode: "live",
    lastSyncedAt: null,
    webhookDetail: { uri: state.webhookUrl },
    code: channelCode,
    team: { name: "Testing", code: teamCode, returnsPolicyUrl: null },
  })

  // Print Trail's timestamps have one-second resolution.
  const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z")

  // With preOrderRelease, pre-order lines (then, given outOfStock, lines short
  // of stock) go in fulfilments of their own per location, held as
  // back-orders, before the others (API 1.3.0).
  const buildFulfilments = (o: any, outOfStock: Set<string> = new Set()) => {
    const groups = new Map<string, { loc: string; reason: string | null; lines: any[] }>()
    for (const line of o.orderLines) {
      const loc = locations[line.product.sku] ?? "UK1"
      const reason = !state.preOrderRelease
        ? null
        : statusOf(line.product.sku) === "pre-order"
          ? "pre-order"
          : outOfStock.has(line.product.sku) ? "out-of-stock" : null
      const key = `${reason ? 0 : 1}|${reason}|${loc}`
      const g = groups.get(key) ?? { loc, reason, lines: [] }
      g.lines.push(line)
      groups.set(key, g)
    }
    let n = 0
    o.fulfilments = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, { loc, reason, lines }]) => {
      const uuid = randomUUID()
      lines.forEach((l) => (l.fulfilmentUuid = uuid))
      const codes = methodsByLocation[loc] ?? CODES
      return {
        uuid,
        fulfilmentNumber: `${o.printTrailOrderNumber}-${++n}`,
        productionMethod: "stock",
        supplierLocation: { code: loc, name: loc },
        status: reason ? "back-order" : "draft",
        orderLines: lines,
        availableShippingMethods: METHODS.filter((m) => codes.includes(m.code)),
        requestedShippingMethod: null,
        trackingDetails: [],
        backOrderReason: reason,
        sentToWarehouseAt: null,
      }
    })
  }

  // API 1.3.0: a back-order Print Trail holds (never sent to the warehouse).
  const isHeld = (f: any) =>
    f.status === "back-order" && !f.sentToWarehouseAt && ["pre-order", "out-of-stock"].includes(f.backOrderReason)

  // The pre-order allowance left for a limited pre-order SKU, or null: the
  // limit less the quantity on held back-orders of confirmed, uncancelled
  // orders.
  const remainingOf = (sku: string): number | null => {
    const limit = state.preOrderLimit[sku]
    if (limit === undefined || statusOf(sku) !== "pre-order") return null
    let committed = 0
    for (const o of state.orders.values()) {
      if (!o.confirmedAt || o.status === "cancelled") continue
      for (const f of o.fulfilments) {
        if (!isHeld(f)) continue
        for (const l of f.orderLines) if (l.product.sku === sku) committed += l.quantity
      }
    }
    return Math.max(0, limit - committed)
  }

  // Lines over a limited pre-order SKU's allowance: Print Trail's flat 409 errors.
  const overLimit = (o: any) => {
    const wanted = new Map<string, number>()
    for (const l of o.orderLines) wanted.set(l.product.sku, (wanted.get(l.product.sku) ?? 0) + l.quantity)
    return [...wanted.entries()]
      .map(([sku, requested]) => ({ sku, requested, available: remainingOf(sku) }))
      .filter((x): x is { sku: string; requested: number; available: number } =>
        x.available !== null && x.requested > x.available)
  }

  // Print Trail sends stock-level-updated when an order takes or gives back part
  // of a pre-order limit (confirm, cancel, amend): after the reply, as Print
  // Trail queues it. changed: the SKUs an amend changed (default: the order's).
  const limitChanged = (o: any, changed?: string[]) => {
    if (!state.preOrderRelease || !state.webhookUrl) return
    const skus = [...new Set<string>(changed ?? o.orderLines.map((l: any) => l.product.sku))]
      .filter((sku) => statusOf(sku) === "pre-order" && state.preOrderLimit[sku] !== undefined)
    if (!skus.length) return
    setImmediate(() => {
      sendWebhook("stock-level-updated", undefined, { extra: { products: skus.map(stockItem) } }).catch(() => undefined)
    })
  }

  const stockItem = (sku: string) => {
    const { sku: s, ...rest } = stockRow(sku)
    return { sku: s, productUuid: `prod-${sku}`, ...rest }
  }

  const stockFigure = (sku: string) => remainingOf(sku) ?? state.stock[sku]

  // A stock row (and a stock-level-updated item, with productUuid).
  const stockRow = (sku: string) => state.preOrderRelease
    ? {
        sku,
        stock: stockFigure(sku),
        status: statusOf(sku),
        publicationDate: publicationOf(sku),
        preOrderLimit: statusOf(sku) === "pre-order" ? (state.preOrderLimit[sku] ?? null) : null,
        preOrderRemaining: remainingOf(sku),
      }
    : { sku, stock: state.stock[sku] ?? 0 }

  // Print Trail's finished statuses (API 1.1.1).
  const FINISHED_STATUSES = ["complete", "cancelled", "failed", "returned", "partial"]

  // Whether Print Trail counts the order as confirmed. An older Print Trail API
  // had no confirmedAt: status and the countdown only, so a confirmed order
  // held after its countdown cleared could be re-posted.
  const wasConfirmed = (o: any) =>
    (!state.legacy && !!o.confirmedAt) || ["queued", "scheduled", "processing"].includes(o.status) || !!o.fulfillableFrom

  // API 1.2.0's request limits (not in legacy).
  const overLimits = (body: any, create: boolean) => {
    if (state.legacy) return null
    const list: { property: string; message: string }[] = []
    const lines: any[] = Array.isArray(body?.orderLines) ? body.orderLines : []
    if (lines.length > MAX_ORDER_LINES) {
      list.push({ property: "orderLines", message: `An order may have at most ${MAX_ORDER_LINES} order lines.` })
    }
    if (create) {
      for (const key of ["orderNumber", "printTrailOrderNumber"]) {
        if (typeof body?.[key] === "string" && [...body[key]].length > MAX_LENGTH) {
          list.push({ property: key, message: `The ${key} field must not be greater than ${MAX_LENGTH} characters.` })
        }
      }
    }
    lines.forEach((l, i) => {
      if (typeof l?.product?.sku === "string" && [...l.product.sku].length > MAX_LENGTH) {
        list.push({ property: `orderLines.${i}.product.sku`, message: `The orderLines.${i}.product.sku field must not be greater than ${MAX_LENGTH} characters.` })
      }
    })
    return list.length ? { status: 422, body: violations(list) } : null
  }

  const TEAM_INACTIVE = "This team is inactive. Orders cannot be created, imported or processed."
  const teamInactive = (detail = TEAM_INACTIVE) =>
    ({ status: 403, body: { type: "http://www.w3.org/Protocols/rfc2616/rfc2616-sec10.html", title: "Forbidden", status: 403, detail } })

  const createOrder = (body: any) => {
    const limited = overLimits(body, true)
    if (limited) return limited
    if (state.teamInactive && !state.legacy) return teamInactive()
    const existing = body.uuid
      ? state.orders.get(body.uuid)
      : [...state.orders.values()].find((o) => o.orderNumber === body.orderNumber)
    // Print Trail replaces an order that was never confirmed and can still be
    // deleted: not finished or cancelled, and nothing under way. The mock reads
    // "nothing under way" as every fulfilment still draft.
    const finished = (o: any) => FINISHED_STATUSES.includes(o.status)
    const deletable = (o: any) =>
      !finished(o) && o.fulfilments.every((f: any) => f.status === "draft" || isHeld(f))
    const replaceable = !!existing && !wasConfirmed(existing) && deletable(existing)
    if (existing && !replaceable) {
      // API 1.1.1: a finished order is checked first, so one that was
      // confirmed and has since finished answers not-updatable. Under 1.1.0 a
      // once-confirmed order was "already confirmed" whatever its status, and
      // legacy answers that untyped. (The API before 1.1.0 answered a
      // finished order with a 500, which the mock doesn't model.)
      const confirmedBefore = wasConfirmed(existing) && (state.legacy || !finished(existing))
      const detail = confirmedBefore || state.legacy
        ? `Order ${existing.uuid} (${existing.orderNumber}) in state "${existing.status}" has already been confirmed for processing and cannot be replaced via the API`
        : `Order ${existing.uuid} (${existing.orderNumber}) in state "${existing.status}" can no longer be updated`
      if (state.legacy) {
        return { status: 409, body: problem(409, "Conflict", detail) }
      }
      // API 1.1.0: the problem type names the case, and data is the order.
      return {
        status: 409,
        body: {
          ...problem(409, "Conflict", detail),
          type: `${PROBLEMS}${confirmedBefore ? "order-already-confirmed" : "order-not-updatable"}`,
          orderUuid: existing.uuid,
          orderStatus: existing.status,
          data: existing,
        },
      }
    }
    const unknown = (body.orderLines ?? [])
      .map((l: any) => l.product?.sku)
      .filter((s: string) => !findSku(s))
    if (body.strictSkus && unknown.length) {
      return {
        status: 422,
        body: { message: "One or more order lines reference unknown SKUs", unmatchedSkus: unknown },
      }
    }
    // Before API 1.3.0, any pre-order product leaves the order a draft it
    // can't fulfil, with no fulfilments, and confirm 428s.
    // With preOrderRelease (API 1.3.0) they're held as a back-order instead.
    const preOrder = state.preOrderRelease ? [] : (body.orderLines ?? [])
      .map((l: any) => findSku(l.product?.sku))
      .filter((s: string | undefined) => s && statusOf(s) === "pre-order")
    const uuid = existing?.uuid ?? randomUUID()
    const o: any = {
      uuid,
      orderNumber: body.orderNumber,
      printTrailOrderNumber: `${teamCode}-${String(body.orderNumber).toLowerCase()}`,
      purchaseOrder: body.purchaseOrder ?? null,
      status: "draft",
      fulfillableStatus: state.createFulfillableStatus,
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
      reservationsExpireAt: null,
      fulfillableFrom: null,
      scheduledAt: null,
      confirmedAt: null,
      shippingDetails: body.shippingDetails ?? null,
      orderLines: (body.orderLines ?? [])
        .filter((l: any) => findSku(l.product?.sku))
        .map((l: any) => ({
          uuid: randomUUID(),
          quantity: l.quantity,
          lineNumber: l.lineNumber,
          fulfilmentUuid: null,
          product: { sku: findSku(l.product.sku) },
        })),
      errors: [
        ...unknown.map((sku: string) => ({
          code: "product-not-found",
          key: "product-not-found",
          message: `Product ${sku} not found`,
        })),
        ...preOrder.map((sku: string) => ({
          code: "product_preorder",
          key: "product",
          message: `Product ${sku} is on pre-order`,
        })),
      ],
    }
    if (body.reserve && state.preOrderRelease) {
      const over = overLimit(o)
      if (over.length) {
        return { status: 409, body: { message: "Stock unavailable for one or more items", errors: over } }
      }
    }
    buildFulfilments(o)
    if (preOrder.length) {
      o.fulfilments = []
      o.orderLines.forEach((l: any) => (l.fulfilmentUuid = null))
      o.fulfillableStatus = "not-fulfillable"
    }
    state.orders.set(uuid, o)
    return { status: 201, body: o }
  }

  const confirmOrder = (o: any, body: any) => {
    if (o.status !== "draft") {
      return { status: 202, body: { data: o } }
    }
    // Refused before anything changes; an already-confirmed order still 202s.
    if (state.teamInactive && !state.legacy) return teamInactive()
    const requested = [
      body?.defaultShippingMethod,
      ...(body?.fulfilmentShippingMethods ?? []).map((f: any) => f.shippingMethod),
    ].filter(Boolean)
    const badCode = requested.find((c: string) => !CODES.includes(c))
    if (badCode) {
      return {
        status: 422,
        body: problem(422, "Unprocessable Entity", `The shipping method "${badCode}" is invalid.`),
      }
    }
    const unknownFulfilment = (body?.fulfilmentShippingMethods ?? []).find(
      (f: any) => !o.fulfilments.some((x: any) => x.uuid === f.fulfilmentUuid)
    )
    if (unknownFulfilment) {
      return {
        status: 422,
        body: problem(
          422,
          "Unprocessable Entity",
          `Unknown fulfilment "${unknownFulfilment.fulfilmentUuid}".`
        ),
      }
    }
    if (o.fulfillableStatus !== "fulfillable") {
      return {
        status: 428,
        body: problem(
          428,
          "Precondition Required",
          `This order is not in a state (${o.status} + ${o.fulfillableStatus}) that can be confirmed.`
        ),
      }
    }
    // API 1.3.0: pre-order lines hold no stock (a limited SKU checks its
    // allowance); a back-order warehouse takes short lines as a back-order.
    const waits = (sku: string) => state.preOrderRelease && statusOf(sku) === "pre-order"
    const lacking = o.orderLines
      .map((l: any) => ({ sku: l.product.sku, requested: l.quantity, available: state.stock[l.product.sku] ?? 0 }))
      .filter((s: any) => !waits(s.sku) && s.available < 10000 && s.requested > s.available)
    const outOfStock = new Set<string>(
      state.preOrderRelease && state.backorderWarehouse ? lacking.map((s: any) => s.sku) : []
    )
    const short = [
      ...lacking.filter((s: any) => !outOfStock.has(s.sku)),
      ...(state.preOrderRelease ? overLimit(o) : []),
    ]
    if (short.length) {
      return {
        status: 409,
        body: { message: "Stock unavailable for one or more items", errors: short },
      }
    }
    const methodFor = (f: any) =>
      (body?.fulfilmentShippingMethods ?? []).find((x: any) => x.fulfilmentUuid === f.uuid)
        ?.shippingMethod ??
      body?.defaultShippingMethod ??
      "standard"
    const unavailable = o.fulfilments.find(
      (f: any) => !f.availableShippingMethods.some((m: any) => m.code === methodFor(f))
    )
    // Print Trail regenerates fulfilments while confirming, so a refusal here
    // carries the new uuids.
    const chosen = o.fulfilments.map(methodFor)
    buildFulfilments(o, outOfStock)
    if (unavailable) {
      const available = unavailable.availableShippingMethods.map((m: any) => m.code).join(", ")
      return {
        status: 409,
        body: problem(
          409,
          "Conflict",
          `The shipping method "${methodFor(unavailable)}" is not available for fulfilment "${unavailable.fulfilmentNumber}". Available: ${available}.`,
          { data: o }
        ),
      }
    }
    o.fulfilments.forEach((f: any, i: number) => {
      f.requestedShippingMethod = chosen[i] ?? methodFor(f)
      if (f.status !== "back-order") f.status = "processing"
    })
    // Print Trail: queued, waiting fulfilments included; the mock has no countdown,
    // so a test moves a waiting order on with setStatus(uuid, "back-order").
    o.status = "queued"
    o.fulfillableFrom = now()
    o.confirmedAt ??= now()
    o.updatedAt = now()
    limitChanged(o)
    return { status: 202, body: { data: o } }
  }

  const cancelOrder = (o: any) => {
    if (["complete", "cancelled", "returned", "failed"].includes(o.status) ||
        o.fulfilments.some((f: any) => f.status === "dispatched")) {
      return {
        status: 428,
        body: problem(
          428,
          "Precondition Required",
          `This order is not in a state (${o.status}) that can be cancelled.`
        ),
      }
    }
    // API 1.3.0: anything sent to the warehouse means 202; held back-orders don't.
    if (o.status === "processing" || (state.preOrderRelease && o.fulfilments.some((f: any) => f.sentToWarehouseAt))) {
      return { status: 202, body: { data: o } }
    }
    o.status = "cancelled"
    o.fulfilments.forEach((f: any) => (f.status = "cancelled"))
    o.updatedAt = now()
    limitChanged(o)
    return { status: 200, body: { data: o } }
  }

  const amendLines = (o: any, body: any) => {
    const limited = overLimits(body, false)
    if (limited) return limited
    if (state.teamInactive && !state.legacy) {
      return {
        status: 403,
        body: problem(403, "Forbidden", "This team is inactive, so its orders cannot be changed.", {
          reason: "team-inactive",
          merchantMessage: "This Print Trail team is inactive, so the order can't be changed.",
        }),
      }
    }
    // API 1.3.0: also while the only non-draft fulfilments are held
    // back-orders, and never once anything is sent.
    const held = (f: any) => state.preOrderRelease && isHeld(f)
    const amendable = (["draft", "queued", "scheduled"].includes(o.status) ||
        (o.status === "back-order" && state.preOrderRelease && o.fulfilments.every(held))) &&
      !(state.preOrderRelease && o.fulfilments.some((f: any) => f.sentToWarehouseAt)) &&
      o.fulfilments.every((f: any) => held(f) ||
        (["draft", "processing"].includes(f.status) && f.trackingDetails.length === 0)) &&
      o.fulfilments.every((f: any) => o.status === "draft" ? f.status === "draft" || held(f) : true)
    if (!amendable) {
      return {
        status: 409,
        body: problem(409, "Conflict", "This order can no longer be amended.", {
          reason: "fulfilment-underway",
          merchantMessage: "Print Trail has started on this order.",
          orderStatus: o.status,
          fulfilments: o.fulfilments.map((f: any) => ({
            uuid: f.uuid,
            fulfilmentNumber: f.fulfilmentNumber,
            status: f.status,
          })),
        }),
      }
    }
    const changes: any[] = []
    const next: any[] = []
    for (const line of body?.orderLines ?? []) {
      const current = o.orderLines.find((l: any) => l.lineNumber === line.lineNumber)
      if (!current && !line.product) {
        return {
          status: 422,
          body: problem(422, "Unprocessable Entity", "New lines need a product.", { reason: "invalid-lines" }),
        }
      }
      if (line.quantity > 0) {
        const sku = current?.product.sku ?? findSku(line.product?.sku)
        next.push({ uuid: current?.uuid ?? randomUUID(), quantity: line.quantity, lineNumber: line.lineNumber, fulfilmentUuid: null, product: { sku } })
      }
      if (!current) {
        changes.push({ lineNumber: line.lineNumber, change: "added", from: 0, to: line.quantity, sku: line.product?.sku })
      } else if (current.quantity !== line.quantity) {
        changes.push({ lineNumber: line.lineNumber, change: line.quantity ? "quantity_changed" : "removed", from: current.quantity, to: line.quantity, sku: current.product.sku })
      }
    }
    for (const current of o.orderLines) {
      if (!(body?.orderLines ?? []).some((l: any) => l.lineNumber === current.lineNumber)) {
        changes.push({ lineNumber: current.lineNumber, change: "removed", from: current.quantity, to: 0, sku: current.product.sku })
      }
    }
    if (!next.length) {
      return {
        status: 422,
        body: problem(422, "Unprocessable Entity", "An order needs at least one line.", { reason: "no-lines" }),
      }
    }
    // API 1.3.0: the limit is checked whether or not the order holds stock. The
    // rebuild gives back the order's own share first, so it counts as
    // available (the amend's stock-held refusal).
    if (state.preOrderRelease) {
      const own = (sku: string) => !o.confirmedAt ? 0 : o.fulfilments.filter(isHeld)
        .flatMap((f: any) => f.orderLines)
        .filter((l: any) => l.product.sku === sku)
        .reduce((n: number, l: any) => n + l.quantity, 0)
      const wanted = new Map<string, number>()
      for (const l of next) wanted.set(l.product.sku, (wanted.get(l.product.sku) ?? 0) + l.quantity)
      const short = [...wanted.entries()].flatMap(([sku, requested]) => {
        const remaining = remainingOf(sku)
        return remaining === null || requested <= remaining + own(sku) ? [] : [{ sku, requested, available: remaining + own(sku) }]
      })
      if (short.length) {
        const list = short.map((s) => `sku "${s.sku}": ${s.requested} requested, ${s.available} available`).join("; ")
        return {
          status: 409,
          body: problem(409, "Conflict", `The amendment was not applied, and the order is unchanged: there is not enough stock for the amended lines (${list}).`, {
            reason: "stock-held",
            merchantMessage: `Not enough stock for ${short.map((s) => `${s.sku}: ${s.requested} requested, ${s.available} available`).join("; ")}. The change to order ${o.orderNumber} was not applied.`,
            message: "Stock unavailable for one or more items",
            errors: short,
          }),
        }
      }
    }
    o.orderLines = next
    const statuses = o.fulfilments.map((f: any) => f.status)
    const wasOutOfStock = new Set<string>(
      o.fulfilments.filter((f: any) => f.backOrderReason === "out-of-stock")
        .flatMap((f: any) => f.orderLines.map((l: any) => l.product.sku))
    )
    buildFulfilments(o, wasOutOfStock)
    const moving = statuses.find((x: string) => x !== "back-order") ?? (o.status === "draft" ? "draft" : "processing")
    if (moving !== "draft") {
      o.fulfilments.forEach((f: any) => {
        if (f.status !== "back-order") f.status = moving
      })
    }
    // Print Trail re-queues a waiting order after an amend; it waits again.
    if (o.status === "back-order") o.status = "queued"
    o.updatedAt = now()
    if (changes.length) limitChanged(o, changes.map((c) => c.sku))
    return {
      status: 200,
      body: {
        data: o,
        amendment: {
          result: changes.length ? "amended" : "unchanged",
          message: changes.length ? "Order amended" : "No changes",
          changes,
          status: o.status,
          requeued: o.status !== "draft",
          fulfillableFrom: o.fulfillableFrom,
          scheduledAt: o.scheduledAt,
        },
      },
    }
  }

  // Keyset paging as Print Trail does it: ordered by (updatedAt, uuid),
  // updated-since inclusive, and an opaque cursor naming the last row of the
  // previous page.
  const encodeCursor = (o: any) => Buffer.from(`${o.updatedAt}|${o.uuid}`).toString("base64url")
  const decodeCursor = (c: string) => {
    const text = Buffer.from(c, "base64url").toString("utf8")
    const at = text.indexOf("|")
    const updatedAt = text.slice(0, at)
    if (at < 1 || Number.isNaN(Date.parse(updatedAt)) || !text.slice(at + 1)) return null
    return { updatedAt, uuid: text.slice(at + 1) }
  }

  const listOrders = (url: URL, origin: string) => {
    const number = url.searchParams.get("order-number")
    const since = url.searchParams.get("updated-since")
    const rawCursor = url.searchParams.get("cursor")
    const cursor = rawCursor === null ? null : decodeCursor(rawCursor)
    if (rawCursor !== null && !cursor) {
      return { status: 422, body: problem(422, "Unprocessable Entity", "The cursor is invalid.") }
    }
    const all = [...state.orders.values()]
      .filter((o) => !number || o.orderNumber === number)
      .filter((o) => !since || o.updatedAt >= since)
      .filter((o) => !cursor || o.updatedAt > cursor.updatedAt ||
        (o.updatedAt === cursor.updatedAt && o.uuid > cursor.uuid))
      .sort((a, b) => a.updatedAt === b.updatedAt
        ? (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0)
        : (a.updatedAt < b.updatedAt ? -1 : 1))
    const page = all.slice(0, PAGE)
    const nextCursor = all.length > PAGE ? encodeCursor(page[page.length - 1]) : null
    const base = `${origin}/v1/channels/${channelId}/orders`
    const next = nextCursor === null
      ? null
      : `${base}?cursor=${nextCursor}` +
        (since ? `&updated-since=${encodeURIComponent(since)}` : "") +
        (number ? `&order-number=${encodeURIComponent(number)}` : "")
    return {
      status: 200,
      body: {
        data: page,
        links: { first: null, last: null, prev: null, next },
        meta: { path: base, per_page: PAGE, next_cursor: nextCursor, prev_cursor: null },
      },
    }
  }

  const route = (method: string, url: URL, body: any, origin: string): { status: number; body?: unknown } => {
    const m = url.pathname.match(/^\/v1\/channels\/([^/]+)(\/.*)?$/)
    if (!m) {
      return { status: 404, body: { message: "Not Found" } }
    }
    const path = m[2] ?? "/"
    if (m[1] !== channelId) {
      // API 1.2.0: an unknown channel is answered as a bad token.
      return state.legacy
        ? { status: 404, body: problem(404, "Not Found", `The channel ID "${m[1]}" does not exist`) }
        : { status: 401, body: problem(401, "Unauthorized", "Unauthenticated.") }
    }
    if (state.channelInactive && !state.legacy) {
      return {
        status: 403,
        body: {
          type: `${PROBLEMS}channel-inactive`,
          title: "Channel inactive",
          status: 403,
          detail: "This channel is inactive in Print Trail. Its API access and webhooks are suspended until it is made active again.",
        },
      }
    }
    if (method === "GET" && path === "/token") {
      return { status: 200, body: { teamCode, channelCode, channelId } }
    }
    if (method === "GET" && path === "/") return { status: 200, body: { data: channel() } }
    if (method === "POST" && path === "/webhooks") {
      if (!state.legacy) {
        const refusal = webhookUrlRefusal(body?.url, state.allowLocalWebhooks)
        if (refusal) return { status: 422, body: violations([{ property: "url", message: refusal }]) }
        if (state.teamInactive) return teamInactive("This team is inactive. Webhooks cannot be registered.")
      }
      state.webhookUrl = body?.url ?? null
      return { status: 200, body: { data: withSecret() } }
    }
    if (method === "POST" && path === "/webhooks/secret/rotate" && !state.legacy) {
      state.webhookSecret = randomBytes(32).toString("hex")
      return { status: 200, body: { data: withSecret() } }
    }
    if (method === "POST" && path === "/test-connection") {
      return { status: 200, body: { message: "Connection OK", timestamp: now() } }
    }
    if (method === "GET" && path === "/shipping-methods") return { status: 200, body: METHODS }
    if (method === "GET" && path === "/stock-levels") {
      const rows: any[] = Object.keys(state.stock).map(stockRow)
      for (let i = 0; i < state.nullSkuRows; i++) {
        rows.push(state.preOrderRelease
          ? { sku: null, stock: 5, status: "active", publicationDate: null, preOrderLimit: null, preOrderRemaining: null }
          : { sku: null, stock: 5 })
      }
      return { status: 200, body: rows }
    }
    if (method === "POST" && path === "/products/validate-skus") {
      const results = (body?.skus ?? []).map((sku: string) => {
        const match = findSku(sku)
        return match
          ? { sku, state: "matched", matchedSku: match, uuid: `prod-${match}`, status: statusOf(match) }
          : { sku, state: "unknown" }
      })
      const matched = results.filter((r: any) => r.state === "matched").length
      return { status: 200, body: { results, summary: { matched, unknown: results.length - matched } } }
    }
    if (method === "POST" && path === "/orders") return createOrder(body)
    if (method === "GET" && path === "/orders") return listOrders(url, origin)

    const om = path.match(/^\/orders\/([^/]+)(\/confirm|\/cancel|\/lines)?$/)
    if (om) {
      const o = state.orders.get(om[1])
      if (!o) return { status: 404, body: problem(404, "Not Found", "This order could not be found.") }
      if (method === "GET" && !om[2]) return { status: 200, body: { data: o } }
      if (method === "PUT" && om[2] === "/confirm") return confirmOrder(o, body)
      if ((method === "PUT" && om[2] === "/cancel") || (method === "DELETE" && !om[2])) return cancelOrder(o)
      if (method === "PUT" && om[2] === "/lines") return amendLines(o, body)
    }
    return { status: 404, body: { message: "Not Found" } }
  }

  // An older Print Trail API has no confirmedAt: the key is left out, not sent as
  // null. Without preOrderRelease, API 1.3.0's fulfilment keys are left out; with
  // it, each line's product carries its current status and pre-order figures.
  const PRE_ORDER_KEYS = new Set(["backOrderReason", "sentToWarehouseAt"])
  const json = (payload: unknown) =>
    JSON.stringify(payload, function (k, v) {
      if (state.legacy && k === "confirmedAt") return undefined
      if (!state.preOrderRelease && PRE_ORDER_KEYS.has(k) && Array.isArray(this?.orderLines)) return undefined
      if (state.preOrderRelease && k === "product" && v && typeof v.sku === "string" && Object.keys(v).length === 1) {
        return {
          ...v,
          activeState: statusOf(v.sku),
          publicationDate: publicationOf(v.sku),
          preOrderLimit: statusOf(v.sku) === "pre-order" ? (state.preOrderLimit[v.sku] ?? null) : null,
          preOrderRemaining: remainingOf(v.sku),
        }
      }
      return v
    })

  const server = http.createServer(async (req, res) => {
    let raw = ""
    for await (const chunk of req) raw += chunk
    let body: any = null
    try {
      body = raw ? JSON.parse(raw) : null
    } catch {
      body = null
    }
    const url = new URL(req.url ?? "/", "http://mock")
    const origin = `http://${req.headers.host}`
    state.requests.push({ method: req.method ?? "GET", path: url.pathname + url.search, body })

    const send = (status: number, payload?: unknown, headers: Record<string, string> = {}) => {
      const version = state.apiVersion
      res.writeHead(status, {
        ...headers,
        "Content-Type": "application/json",
        ...(version !== null && url.pathname.startsWith("/v1/") ? { "Print-Trail-Api-Version": version } : {}),
      })
      res.end(payload === undefined ? "" : json(payload))
    }

    const failure = failures.find((f) => f.times > 0 && f.path.test(url.pathname))
    if (failure) {
      failure.times--
      return send(failure.status, failure.body, failure.headers)
    }
    if (url.pathname.startsWith("/v1/channels/") && req.headers.authorization !== `Bearer ${token}`) {
      return send(401, problem(401, "Unauthorized", "Unauthenticated."))
    }
    // Test control (no token, no /v1): what Print Trail's app does to a product.
    const control = url.pathname.match(/^\/__mock\/products\/([^/]+)$/)
    if (req.method === "POST" && control) {
      const sku = findSku(decodeURIComponent(control[1])) ?? decodeURIComponent(control[1])
      await changeProduct(sku, body ?? {})
      return send(200, stockRow(sku))
    }
    const result = route(req.method ?? "GET", url, body, origin)
    send(result.status, result.body)
  })

  const get = (uuid: string) => {
    const o = state.orders.get(uuid)
    // The mock is self-contained, so no MedusaError here.
    // eslint-disable-next-line @medusajs/use-medusa-error-not-generic-error
    if (!o) throw new Error(`mock: no order ${uuid}`)
    return o
  }

  const trackingEntry = (f: any, i: number, n: number) => {
    const number = `JD00022700600${String(i).padStart(5, "0")}${n ? `-${n}` : ""}`
    const url = `https://www.royalmail.com/track-your-item#/tracking-results/${number}`
    return {
      carrier: "Royal Mail", trackingNumber: number, trackingUrl: url,
      methodName: f.requestedShippingMethod ?? "standard", shippedAt: now(),
      courier: "Royal Mail", number, url,
    }
  }

  // Print Trail's order status once fulfilments move: complete
  // when every fulfilment dispatched; partial (final) when every fulfilment
  // has finished, at least one dispatched and at least one failed or was
  // cancelled. While parcels are still in progress the order is processing.
  const settle = (o: any) => {
    const fs = o.fulfilments
    const dispatched = fs.filter((f: any) => f.status === "dispatched").length
    const lost = fs.filter((f: any) => f.status === "cancelled" || f.status === "failed").length
    if (!fs.length || !dispatched) return
    if (dispatched === fs.length) o.status = "complete"
    else if (dispatched + lost === fs.length) o.status = "partial"
    else o.status = "processing"
  }

  const dispatch = (uuid: string, fulfilmentIndex?: number, dopts: { tracking?: boolean } = {}) => {
    const o = get(uuid)
    o.fulfilments.forEach((f: any, i: number) => {
      if (fulfilmentIndex !== undefined && i !== fulfilmentIndex) return
      f.status = "dispatched"
      f.sentToWarehouseAt ??= now()
      f.backOrderReason = null
      f.trackingDetails = dopts.tracking === false ? [] : [trackingEntry(f, i, 0)]
    })
    settle(o)
    o.updatedAt = now()
  }

  const addTracking = (uuid: string, fulfilmentIndex: number) => {
    const o = get(uuid)
    const f = o.fulfilments[fulfilmentIndex]
    f.trackingDetails = [...f.trackingDetails, trackingEntry(f, fulfilmentIndex, f.trackingDetails.length)]
    o.updatedAt = now()
  }

  const setStatus = (uuid: string, status: string, fulfillableStatus?: string) => {
    const o = get(uuid)
    o.status = status
    if (status === "draft") o.confirmedAt = null
    if (fulfillableStatus !== undefined) o.fulfillableStatus = fulfillableStatus
    if (status === "cancelled") o.fulfilments.forEach((f: any) => (f.status = "cancelled"))
    // Print Trail marks every fulfilment returned with the order.
    if (status === "returned") o.fulfilments.forEach((f: any) => (f.status = "returned"))
    o.updatedAt = now()
  }

  const cancelFulfilment = (uuid: string, index: number) => {
    const o = get(uuid)
    o.fulfilments[index].status = "cancelled"
    settle(o)
    o.updatedAt = now()
  }

  const setShippingMethod = (uuid: string, index: number, code: string) => {
    const o = get(uuid)
    o.fulfilments[index].requestedShippingMethod = code
    o.updatedAt = now()
  }

  const fullEdit = (uuid: string) => {
    const o = get(uuid)
    o.status = "draft"
    o.confirmedAt = null
    o.fulfillableFrom = null
    o.fulfilments = []
    o.orderLines.forEach((l: any) => (l.fulfilmentUuid = null))
    o.updatedAt = now()
  }

  const copy = (uuid: string) => {
    const o = get(uuid)
    const orderNumber = `${o.orderNumber}-COPY`
    const c: any = {
      ...JSON.parse(JSON.stringify(o)),
      uuid: randomUUID(),
      orderNumber,
      printTrailOrderNumber: `${teamCode}-${orderNumber.toLowerCase()}`,
      status: "draft",
      fulfillableFrom: null,
      confirmedAt: null,
      createdAt: now(),
      updatedAt: now(),
    }
    c.orderLines.forEach((l: any) => (l.uuid = randomUUID()))
    buildFulfilments(c)
    state.orders.set(c.uuid, c)
    return c.uuid
  }

  const settleCancel = (uuid: string, outcome: "cancelled" | "dispatched" | "partial") => {
    const o = get(uuid)
    o.fulfilments.forEach((f: any, i: number) => {
      const ships = outcome === "dispatched" || (outcome === "partial" && i === 0)
      f.status = ships ? "dispatched" : "cancelled"
      f.trackingDetails = ships ? [trackingEntry(f, i, 0)] : f.trackingDetails
    })
    o.status = outcome === "dispatched" ? "complete" : "cancelled"
    o.updatedAt = now()
  }

  const setUpdatedAt = (uuid: string, iso: string) => {
    get(uuid).updatedAt = iso
  }

  const reset = () => {
    state.orders.clear()
    state.requests.length = 0
    state.stock = { ...startStock }
    state.skuStatus = { ...(opts.skuStatus ?? {}) }
    state.nullSkuRows = 0
    state.webhookUrl = null
    state.createFulfillableStatus = "fulfillable"
    state.legacy = opts.legacy ?? false
    state.webhookSecret = opts.webhookSecret ?? "mock-secret"
    state.publicationDate = { ...(opts.publicationDate ?? {}) }
    state.preOrderLimit = { ...(opts.preOrderLimit ?? {}) }
    state.backorderWarehouse = opts.backorderWarehouse ?? false
    state.allowLocalWebhooks = opts.allowLocalWebhooks ?? true
    state.channelInactive = opts.channelInactive ?? false
    state.teamInactive = opts.teamInactive ?? false
    preOrderReleaseSet = undefined
    apiVersionSet = undefined
    failures.length = 0
  }

  const sendWebhook: MockPrintTrail["sendWebhook"] = async (type, orderUuid, wopts = {}) => {
    const url = wopts.url ?? state.webhookUrl
    // eslint-disable-next-line @medusajs/use-medusa-error-not-generic-error
    if (!url) throw new Error("mock: no webhook URL registered")
    // API 1.2.0 sends an inactive channel nothing, and checks the URL again
    // before every delivery.
    if (!state.legacy && (state.channelInactive || webhookUrlRefusal(url, state.allowLocalWebhooks))) {
      return { status: 0, body: null }
    }
    const o = orderUuid ? state.orders.get(orderUuid) : undefined
    const base = { notificationType: type, tenantCode: teamCode, channelCode, message: `${type} notification` }
    const payload = type === "stock-level-updated"
      ? {
          ...base,
          changedAt: now(),
          products: Object.keys(state.stock).map((sku) => {
            const { sku: s, ...rest } = stockRow(sku)
            return { sku: s, productUuid: `prod-${sku}`, ...rest }
          }),
          ...wopts.extra,
        }
      : {
          ...base,
          ...(orderUuid ? { orderUuid } : {}),
          orderNumber: o?.orderNumber ?? null,
          createdAt: o?.createdAt ?? now(),
          updatedAt: o?.updatedAt ?? now(),
          confirmedAt: o?.confirmedAt ?? null,
          ...wopts.extra,
        }
    const bytes = wopts.body ?? json(payload)
    const signature = wopts.signature ??
      createHmac("sha256", wopts.secret ?? state.webhookSecret).update(bytes).digest("hex")
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Signature: signature,
        ...(state.apiVersion !== null ? { "Print-Trail-Api-Version": state.apiVersion } : {}),
      },
      body: bytes,
    })
    const text = await res.text()
    let body: unknown = text
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    return { status: res.status, body }
  }

  // API 1.3.0's release: per fulfilment, oldest order first, against a running
  // tally of stock. Only a product that is active releases: while any line's
  // product isn't (on pre-order, or set inactive while it waited) the reason is
  // pre-order, read from the products as they are now, so an out-of-stock
  // back-order whose product goes back on pre-order switches with no webhook
  // and no updatedAt change. A held fulfilment whose products are all active is
  // released when the tally covers every line, else it waits as out-of-stock (a
  // switch from pre-order moves updatedAt and sends no webhook). A pure order's
  // fulfilment goes back to draft and the order is re-queued; a part of an
  // order already under way is sent at once. An unconfirmed draft's goes back
  // to draft too, holding no stock (only a confirmed order holds or sends).
  const release = async () => {
    const tally: Record<string, number> = { ...state.stock }
    const events: { o: any; f: any; from: string | null }[] = []
    const orders = [...state.orders.values()]
      .filter((o) => o.status !== "cancelled")
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    for (const o of orders) {
      const confirmed = !!o.confirmedAt
      for (const f of o.fulfilments) {
        if (!isHeld(f)) continue
        const skus = f.orderLines.map((l: any) => l.product.sku)
        if (skus.some((s: string) => statusOf(s) !== "active")) {
          f.backOrderReason = "pre-order"
          continue
        }
        const covered = f.orderLines.every((l: any) => (tally[l.product.sku] ?? 0) >= 10000 ||
          (tally[l.product.sku] ?? 0) >= l.quantity)
        if (!covered) {
          if (f.backOrderReason !== "out-of-stock") {
            f.backOrderReason = "out-of-stock"
            o.updatedAt = now()
          }
          continue
        }
        for (const l of confirmed ? f.orderLines : []) {
          if ((tally[l.product.sku] ?? 0) < 10000) tally[l.product.sku] -= l.quantity
        }
        // Print Trail: back to draft (confirmedAt kept). An order already under
        // way sends it at once; a pure one is re-queued and waits for its
        // countdown (a test moves it on with sendToWarehouse or dispatch).
        const underWay = confirmed && o.status === "processing"
        f.status = underWay ? "processing" : "draft"
        f.backOrderReason = null
        if (underWay) f.sentToWarehouseAt = now()
        const from = o.status
        if (o.status === "back-order") o.status = "queued"
        o.updatedAt = now()
        events.push({ o, f, from })
      }
    }
    if (!state.webhookUrl) return
    for (const { o, f, from } of events) {
      await sendWebhook("fulfilment-status-updated", o.uuid, {
        extra: {
          originalFulfilmentStatus: "back-order",
          currentFulfilmentStatus: f.status,
          orderStatus: o.status,
          products: f.orderLines.map((l: any) => l.product.sku),
          backOrderReason: f.backOrderReason,
          sentToWarehouseAt: f.sentToWarehouseAt,
        },
      })
      if (from !== o.status) {
        await sendWebhook("order-status-updated", o.uuid, {
          extra: { originalOrderStatus: from, currentOrderStatus: o.status },
        })
      }
    }
  }

  const changeProduct = async (
    sku: string,
    change: { status?: SkuStatus; publicationDate?: string | null; stock?: number }
  ) => {
    if (typeof change.stock === "number") state.stock[sku] = change.stock
    if (change.status) state.skuStatus[sku] = change.status
    if (change.publicationDate !== undefined) {
      if (change.publicationDate === null) delete state.publicationDate[sku]
      else state.publicationDate[sku] = change.publicationDate
    }
    await release()
    if (state.webhookUrl) {
      await sendWebhook("stock-level-updated", undefined, { extra: { products: [stockItem(sku)] } })
    }
  }

  const setSkuStatus = (sku: string, status: SkuStatus, publicationDate?: string | null) =>
    changeProduct(sku, { status, publicationDate })

  const restock = (sku: string, stock: number) => changeProduct(sku, { stock })

  const sendToWarehouse = (uuid: string, fulfilmentIndex: number, sopts: { backOrder?: boolean } = {}) => {
    const o = get(uuid)
    const f = o.fulfilments[fulfilmentIndex]
    f.sentToWarehouseAt = now()
    if (sopts.backOrder) {
      f.status = "back-order"
      f.backOrderReason = "warehouse"
    } else if (["draft", "back-order"].includes(f.status)) {
      f.status = "processing"
      f.backOrderReason = null
    }
    if (["queued", "scheduled", "back-order"].includes(o.status)) o.status = "processing"
    o.updatedAt = now()
  }

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}`,
        state,
        reset,
        fail: (path, status, body, times = 1, headers) => failures.push({ path, status, body, times, headers }),
        sendWebhook,
        setStatus,
        cancelFulfilment,
        setShippingMethod,
        fullEdit,
        copy,
        dispatch,
        addTracking,
        setUpdatedAt,
        settleCancel,
        setSkuStatus,
        restock,
        sendToWarehouse,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

if (process.argv[1]?.endsWith("mock-print-trail.ts")) {
  startMockPrintTrail({
    port: Number(process.env.PORT || 4010),
    token: process.env.PT_TOKEN || "dev-token",
    channelId: process.env.PT_CHANNEL_ID || "test-channel",
    webhookSecret: process.env.PT_WEBHOOK_SECRET || "mock-secret",
    legacy: process.env.PT_LEGACY === "1",
    // PT_WEBHOOK_STRICT=1: refuse a plain-http or local webhook URL, as
    // production does (a local store then needs an HTTPS tunnel).
    allowLocalWebhooks: process.env.PT_WEBHOOK_STRICT !== "1",
  }).then((m) => console.log(`mock Print Trail API on ${m.url}`))
}
