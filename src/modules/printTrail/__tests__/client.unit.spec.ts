import { PrintTrailClient } from "../client/client"
import { PrintTrailApiError, PROBLEM_TYPES } from "../client/errors"

const TOKEN = "unit-test-token-value"
const order = { uuid: "ord-1", orderNumber: "ORD-1", status: "draft", fulfilments: [] }

type Reply = { status: number; body?: unknown; text?: string; headers?: Record<string, string> }

function fakeFetch(replies: Reply[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const fn = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const r = replies.shift()
    if (!r) throw new Error("no reply queued")
    const text = r.text ?? (r.body === undefined ? "" : JSON.stringify(r.body))
    return new Response(text, { status: r.status, headers: r.headers })
  })
  return { fetch: fn as unknown as typeof fetch, calls }
}

const client = (f: typeof fetch) =>
  new PrintTrailClient({
    baseUrl: "https://pt.example/",
    channelId: "acme-medusa1",
    apiToken: TOKEN,
    fetch: f,
    retryDelays: [0, 0, 0],
  })

const caught = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e as PrintTrailApiError
  }
  throw new Error("expected a rejection")
}

describe("PrintTrailClient envelopes", () => {
  it("returns the bare order from create", async () => {
    const f = fakeFetch([{ status: 201, body: order }])
    await expect(
      client(f.fetch).createOrder({ orderNumber: "ORD-1", orderLines: [] })
    ).resolves.toEqual(order)
    expect(f.calls[0].url).toBe("https://pt.example/v1/channels/acme-medusa1/orders")
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`
    )
  })

  it("unwraps { data } from get and confirm", async () => {
    const f = fakeFetch([
      { status: 200, body: { data: order } },
      { status: 202, body: { data: { ...order, status: "queued" } } },
    ])
    const c = client(f.fetch)
    await expect(c.getOrder("ord-1")).resolves.toEqual(order)
    await expect(
      c.confirmOrder("ord-1", { defaultShippingMethod: "standard" })
    ).resolves.toMatchObject({ status: "queued" })
    expect(JSON.parse(String(f.calls[1].init.body))).toEqual({
      defaultShippingMethod: "standard",
    })
    expect(f.calls[1].init.method).toBe("PUT")
  })

  it("returns flat bodies as they are", async () => {
    const levels = [{ sku: "A", stock: 3 }]
    const f = fakeFetch([
      { status: 200, body: levels },
      { status: 200, body: { teamCode: "acme", channelCode: "medusa1", channelId: "acme-medusa1" } },
      { status: 200, body: [{ code: "standard", name: "Standard" }] },
    ])
    const c = client(f.fetch)
    await expect(c.stockLevels()).resolves.toEqual(levels)
    await expect(c.getToken()).resolves.toMatchObject({ channelId: "acme-medusa1" })
    await expect(c.listShippingMethods()).resolves.toEqual([
      { code: "standard", name: "Standard" },
    ])
  })

  it("reports the cancel status alongside the order", async () => {
    const f = fakeFetch([{ status: 202, body: { data: { ...order, status: "processing" } } }])
    await expect(client(f.fetch).cancelOrder("ord-1")).resolves.toEqual({
      status: 202,
      order: { ...order, status: "processing" },
    })
  })

  it("finds an order by exact order number only", async () => {
    const f = fakeFetch([
      {
        status: 200,
        body: {
          data: [{ ...order, orderNumber: "ORD-10" }, order],
          links: { next: null },
          meta: {},
        },
      },
    ])
    await expect(client(f.fetch).findOrderByNumber("ORD-1")).resolves.toEqual(order)
    expect(f.calls[0].url).toContain("/orders?order-number=ORD-1")
  })

  it("chunks validate-skus at 250 and merges the results", async () => {
    const skus = Array.from({ length: 300 }, (_, i) => `S${i}`)
    const result = (list: string[]) => ({
      results: list.map((sku) => ({ sku, state: "unknown" })),
      summary: { matched: 0, unknown: list.length },
    })
    const f = fakeFetch([
      { status: 200, body: result(skus.slice(0, 250)) },
      { status: 200, body: result(skus.slice(250)) },
    ])
    const v = await client(f.fetch).validateSkus(skus)
    expect(f.calls).toHaveLength(2)
    expect(v.results).toHaveLength(300)
    expect(v.summary).toEqual({ matched: 0, unknown: 300 })
  })
})

describe("PrintTrailClient retries and errors", () => {
  it("retries a 503 then succeeds", async () => {
    const f = fakeFetch([{ status: 503 }, { status: 200, body: { data: order } }])
    await expect(client(f.fetch).getOrder("ord-1")).resolves.toEqual(order)
    expect(f.calls).toHaveLength(2)
  })

  it("gives up after the retries with a transient error", async () => {
    const f = fakeFetch([{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }])
    const err = await caught(client(f.fetch).getOrder("ord-1"))
    expect(err).toBeInstanceOf(PrintTrailApiError)
    expect(err.isTransient).toBe(true)
    expect(f.calls).toHaveLength(4)
  })

  it("treats a network failure as transient (status 0)", async () => {
    const fn = jest.fn(async () => {
      throw new TypeError("fetch failed")
    }) as unknown as typeof fetch
    const err = await caught(client(fn).getOrder("ord-1"))
    expect(err.status).toBe(0)
    expect(err.isTransient).toBe(true)
  })

  it("treats a body that fails mid-read as a network failure, and retries it", async () => {
    // The timeout signal can fire after the headers arrive, during the body read.
    const stalled = {
      ok: true,
      status: 200,
      statusText: "OK",
      text: () => Promise.reject(new DOMException(`stalled reading Bearer ${TOKEN}`, "TimeoutError")),
    } as unknown as Response
    const fn = jest.fn(async () => stalled) as unknown as typeof fetch
    const err = await caught(client(fn).getOrder("ord-1"))
    expect(err).toBeInstanceOf(PrintTrailApiError)
    expect(err.status).toBe(0)
    expect(err.isTransient).toBe(true)
    expect(fn).toHaveBeenCalledTimes(4)
    expect(err.message).not.toContain(TOKEN)
    expect(err.detail).not.toContain(TOKEN)
  })

  it("does not retry a 422", async () => {
    const f = fakeFetch([
      {
        status: 422,
        body: { message: "One or more order lines reference unknown SKUs", unmatchedSkus: ["X-1"] },
      },
    ])
    const err = await caught(client(f.fetch).createOrder({ orderNumber: "ORD-1", orderLines: [] }))
    expect(f.calls).toHaveLength(1)
    expect(err.status).toBe(422)
    expect(err.unmatchedSkus).toEqual(["X-1"])
  })

  it("tells a stock 409 from a shipping-selection 409", async () => {
    const f = fakeFetch([
      {
        status: 409,
        body: {
          message: "Stock unavailable for one or more items",
          errors: [{ sku: "A", requested: 2, available: 0 }],
        },
      },
      {
        status: 409,
        body: {
          type: "about:blank",
          title: "Conflict",
          status: 409,
          detail: 'The shipping method "air" is not available',
          data: { ...order, uuid: "ord-1" },
        },
      },
    ])
    const c = client(f.fetch)
    const stock = await caught(c.confirmOrder("ord-1", {}))
    expect(stock.stockShortfall).toEqual([{ sku: "A", requested: 2, available: 0 }])
    expect(stock.shippingConflictOrder).toBeNull()
    expect(stock.isProblem).toBe(false)

    const shipping = await caught(c.confirmOrder("ord-1", {}))
    expect(shipping.stockShortfall).toBeNull()
    expect(shipping.shippingConflictOrder).toMatchObject({ uuid: "ord-1" })
    expect(shipping.isProblem).toBe(true)
    expect(shipping.detail).toContain("air")
  })

  it("never puts the token in an error message", async () => {
    const f = fakeFetch([
      { status: 500, text: `<html>Authorization: Bearer ${TOKEN}</html>` },
      { status: 500, text: `<html>Authorization: Bearer ${TOKEN}</html>` },
      { status: 500, text: `<html>Authorization: Bearer ${TOKEN}</html>` },
      { status: 500, text: `<html>Authorization: Bearer ${TOKEN}</html>` },
      {
        status: 401,
        body: { type: "about:blank", title: "Unauthorized", status: 401, detail: `token ${TOKEN}` },
      },
    ])
    const c = client(f.fetch)
    for (const err of [await caught(c.getOrder("x")), await caught(c.getOrder("x"))]) {
      expect(err.message).not.toContain(TOKEN)
      expect(err.message).not.toContain("Bearer")
      expect(err.detail).not.toContain(TOKEN)
    }
  })
})

describe("PrintTrailClient paging", () => {
  it("follows same-host next links and stops at a foreign host", async () => {
    const f = fakeFetch([
      {
        status: 200,
        body: {
          data: [{ ...order, uuid: "a" }],
          links: { next: "https://pt.example/v1/channels/acme-medusa1/orders?cursor=c2" },
          meta: {},
        },
      },
      {
        status: 200,
        body: {
          data: [{ ...order, uuid: "b" }],
          links: { next: "https://evil.example/v1/channels/acme-medusa1/orders?cursor=c3" },
          meta: {},
        },
      },
    ])
    const seen: string[] = []
    for await (const o of client(f.fetch).listOrdersUpdatedSince("2026-10-01T00:00:00Z")) {
      seen.push(o.uuid)
    }
    expect(seen).toEqual(["a", "b"])
    expect(f.calls).toHaveLength(2)
    expect(f.calls[0].url).toBe(
      "https://pt.example/v1/channels/acme-medusa1/orders?updated-since=2026-10-01T00%3A00%3A00Z"
    )
    expect(f.calls[1].url).toBe("https://pt.example/v1/channels/acme-medusa1/orders?cursor=c2")
  })

  it("yields one array per page", async () => {
    const f = fakeFetch([
      {
        status: 200,
        body: {
          data: [{ ...order, uuid: "o1" }, { ...order, uuid: "o2" }],
          links: { next: "https://pt.example/v1/channels/acme-medusa1/orders?cursor=c2" },
          meta: {},
        },
      },
      { status: 200, body: { data: [{ ...order, uuid: "o3" }], links: { next: null }, meta: {} } },
    ])
    const pages: string[][] = []
    for await (const page of client(f.fetch).ordersUpdatedSincePages("2026-10-01T00:00:00Z")) {
      pages.push(page.map((o) => o.uuid))
    }
    expect(pages).toEqual([["o1", "o2"], ["o3"]])
  })

  it("stops paging at a foreign-host next link", async () => {
    const f = fakeFetch([
      {
        status: 200,
        body: {
          data: [{ ...order, uuid: "o1" }],
          links: { next: "https://evil.example/v1/channels/acme-medusa1/orders?cursor=c2" },
          meta: {},
        },
      },
    ])
    const pages: string[][] = []
    for await (const page of client(f.fetch).ordersUpdatedSincePages("2026-10-01T00:00:00Z")) {
      pages.push(page.map((o) => o.uuid))
    }
    expect(pages).toEqual([["o1"]])
    expect(f.calls).toHaveLength(1)
  })
})


describe("PrintTrailClient onStatus", () => {
  it("reports the final status once per request", async () => {
    const seen: [number, string][] = []
    const f = fakeFetch([
      { status: 503, body: { message: "busy" } },
      { status: 200, body: { teamCode: "acme", channelCode: "medusa1", channelId: "acme-medusa1" } },
    ])
    const c = new PrintTrailClient({
      baseUrl: "https://pt.example",
      channelId: "acme-medusa1",
      apiToken: TOKEN,
      fetch: f.fetch,
      retryDelays: [0],
      onStatus: (status, path) => seen.push([status, path]),
    })
    await c.getToken()
    expect(seen).toEqual([[200, "/token"]])

    const g = fakeFetch([{ status: 401, body: { message: "Unauthenticated." } }])
    const seen401: [number, string][] = []
    const d = new PrintTrailClient({
      baseUrl: "https://pt.example",
      channelId: "acme-medusa1",
      apiToken: TOKEN,
      fetch: g.fetch,
      retryDelays: [],
      onStatus: (status, path) => seen401.push([status, path]),
    })
    await caught(d.getToken())
    expect(seen401).toEqual([[401, "/token"]])
  })

  it("reports 0 for a network failure and never fails a request from the callback", async () => {
    const seen: number[] = []
    const failing = jest.fn(async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    const c = new PrintTrailClient({
      baseUrl: "https://pt.example",
      channelId: "c",
      apiToken: TOKEN,
      fetch: failing,
      retryDelays: [],
      onStatus: (s) => seen.push(s),
    })
    expect((await caught(c.getToken())).status).toBe(0)
    expect(seen).toEqual([0])

    const f = fakeFetch([{ status: 200, body: { ok: true } }])
    const throwing = new PrintTrailClient({
      baseUrl: "https://pt.example",
      channelId: "c",
      apiToken: TOKEN,
      fetch: f.fetch,
      onStatus: () => {
        throw new Error("boom")
      },
    })
    await expect(throwing.getToken()).resolves.toEqual({ ok: true })
  })
})

describe("API 1.1.0 additions", () => {
  const SECRET = "a".repeat(64)
  const channel = { id: 1, name: "C", code: "medusa1", webhookDetail: { uri: "https://shop.test/hooks/print-trail", secret: SECRET } }

  it("exposes a typed 409's type and members", async () => {
    const body = {
      type: "https://docs.printtrail.com/channel-api/problems/order-already-confirmed",
      title: "Conflict",
      status: 409,
      detail: "Order x (ORD-1) in state \"queued\" has already been confirmed",
      orderUuid: "ord-1",
      orderStatus: "queued",
      data: { ...order, status: "queued" },
    }
    const err = await caught(client(fakeFetch([{ status: 409, body }]).fetch).createOrder({ orderNumber: "ORD-1", orderLines: [] }))
    expect(err.problemType).toBe(PROBLEM_TYPES.alreadyConfirmed)
    expect(err.orderUuid).toBe("ord-1")
    expect(err.orderStatus).toBe("queued")
    expect(err.problemOrder).toMatchObject({ uuid: "ord-1", status: "queued" })
  })

  it("reads no type or order from a flat body or a malformed data", async () => {
    const flat = await caught(
      client(fakeFetch([{ status: 409, body: { message: "Stock", errors: [{ sku: "A", requested: 2, available: 1 }] } }]).fetch).createOrder({ orderNumber: "x", orderLines: [] })
    )
    expect(flat.problemType).toBeNull()
    expect(flat.problemOrder).toBeNull()
    expect(flat.orderUuid).toBeNull()
    const bad = await caught(
      client(fakeFetch([{ status: 409, body: { type: "about:blank", status: 409, detail: "d", data: { nope: 1 } } }]).fetch).createOrder({ orderNumber: "x", orderLines: [] })
    )
    expect(bad.problemType).toBe("about:blank")
    expect(bad.problemOrder).toBeNull()
  })

  it("registerWebhook returns the secret apart and strips it from the channel", async () => {
    const f = fakeFetch([{ status: 200, body: { data: channel } }])
    const result = await client(f.fetch).registerWebhook("https://shop.test/hooks/print-trail")
    expect(result.secret).toBe(SECRET)
    expect(result.channel.webhookDetail).toEqual({ uri: "https://shop.test/hooks/print-trail" })
    expect(JSON.stringify(result.channel)).not.toContain(SECRET)
  })

  it("registerWebhook reads no secret from an old Print Trail API", async () => {
    const f = fakeFetch([{ status: 200, body: { data: { ...channel, webhookDetail: { uri: "u" } } } }])
    expect((await client(f.fetch).registerWebhook("u")).secret).toBeNull()
    const g = fakeFetch([{ status: 200, body: { data: { ...channel, webhookDetail: { uri: "u", secret: "" } } } }])
    expect((await client(g.fetch).registerWebhook("u")).secret).toBeNull()
  })

  it("rotateWebhookSecret posts to /webhooks/secret/rotate with no body", async () => {
    const f = fakeFetch([{ status: 200, body: { data: channel } }])
    const result = await client(f.fetch).rotateWebhookSecret()
    expect(f.calls[0].url).toBe("https://pt.example/v1/channels/acme-medusa1/webhooks/secret/rotate")
    expect(f.calls[0].init.method).toBe("POST")
    expect(f.calls[0].init.body).toBeUndefined()
    expect(result.secret).toBe(SECRET)
    expect(JSON.stringify(result.channel)).not.toContain(SECRET)
  })
})

describe("PrintTrailClient onApiVersion", () => {
  const make = (f: typeof fetch, onApiVersion: (v: string, p: string) => void, retryDelays = [0]) =>
    new PrintTrailClient({ baseUrl: "https://pt.example", channelId: "c", apiToken: TOKEN, fetch: f, retryDelays, onApiVersion })
  const token = { teamCode: "acme", channelCode: "medusa1", channelId: "c" }

  it("reports the API version header", async () => {
    const seen: [string, string][] = []
    const f = fakeFetch([
      { status: 503, body: { message: "busy" }, headers: { "Print-Trail-Api-Version": "1.2.0" } },
      { status: 200, body: token, headers: { "Print-Trail-Api-Version": " 1.2.0 " } },
      { status: 404, body: { message: "Not Found" }, headers: { "Print-Trail-Api-Version": "1.2.0" } },
    ])
    const c = make(f.fetch, (v, p) => seen.push([v, p]))
    await c.getToken()
    await caught(c.getOrder("nope"))
    // Every response that carries it, retries and errors included.
    expect(seen).toEqual([
      ["1.2.0", "/token"],
      ["1.2.0", "/token"],
      ["1.2.0", "/orders/nope"],
    ])
  })

  it("no header, no call", async () => {
    const seen: string[] = []
    const f = fakeFetch([
      { status: 200, body: token },
      { status: 200, body: token, headers: { "Print-Trail-Api-Version": "  " } },
    ])
    const c = make(f.fetch, (v) => seen.push(v))
    await c.getToken()
    await c.getToken()
    expect(seen).toEqual([])
  })

  it("a throwing onApiVersion doesn't fail the request", async () => {
    const f = fakeFetch([{ status: 200, body: token, headers: { "Print-Trail-Api-Version": "1.1.0" } }])
    const c = make(f.fetch, () => {
      throw new Error("boom")
    })
    await expect(c.getToken()).resolves.toEqual(token)
  })
})

describe("API 1.2.0 error bodies", () => {
  const once = (f: typeof fetch) =>
    new PrintTrailClient({ baseUrl: "https://pt.example", channelId: "c", apiToken: TOKEN, fetch: f, retryDelays: [] })

  it("builds the detail of a validation 422 from its violations", async () => {
    const f = fakeFetch([
      {
        status: 422,
        body: {
          type: "about:blank",
          status: 422,
          title: "Validation errors",
          violations: [
            { property: "url", message: "The url is not allowed: The webhook URL must use https. Webhook URLs must be https on a public host." },
          ],
        },
      },
    ])
    const err = await caught(client(f.fetch).registerWebhook("http://shop.example/hooks/print-trail"))
    expect(err.status).toBe(422)
    expect(err.detail).toBe(
      "url: The url is not allowed: The webhook URL must use https. Webhook URLs must be https on a public host."
    )
    expect(err.violations).toEqual([{ property: "url", message: expect.stringContaining("must use https") }])
    expect(err.message).toContain("must use https")
  })

  it("joins several violations, and keeps a detail when there is one", async () => {
    const f = fakeFetch([
      {
        status: 422,
        body: {
          status: 422,
          title: "Validation errors",
          violations: [
            { property: "orderNumber", message: "The order number may not be greater than 255 characters." },
            { property: "orderLines", message: "The order lines may not have more than 500 items." },
          ],
        },
      },
      { status: 422, body: { status: 422, title: "Unprocessable", detail: "Bad cursor", violations: [] } },
    ])
    const c = client(f.fetch)
    const err = await caught(c.createOrder({ orderNumber: "X", orderLines: [] }))
    expect(err.detail).toBe(
      "orderNumber: The order number may not be greater than 255 characters.; orderLines: The order lines may not have more than 500 items."
    )
    expect((await caught(c.getOrder("x"))).detail).toBe("Bad cursor")
  })

  it("exposes a 500's reference and quotes it once", async () => {
    const ref = "0b6f5c2e-9a1d-4f7e-8c3b-2d4e6f8a1b3c"
    const f = fakeFetch([
      {
        status: 500,
        body: {
          type: "http://www.w3.org/Protocols/rfc2616/rfc2616-sec10.html",
          title: "Internal Server Error",
          status: 500,
          detail: `An unexpected error occurred. If it keeps happening, contact Print Trail support quoting reference ${ref}.`,
          reference: ref,
        },
      },
    ])
    const err = await caught(once(f.fetch).getOrder("x"))
    expect(err.reference).toBe(ref)
    expect(err.isTransient).toBe(true)
    expect(err.detail.split(ref)).toHaveLength(2)
  })

  it("adds the reference to a detail that doesn't quote it (a Print Trail in debug mode)", async () => {
    const ref = "11111111-2222-3333-4444-555555555555"
    const f = fakeFetch([{ status: 500, body: { status: 500, title: "Internal Server Error", detail: "SQLSTATE[HY000]", reference: ref } }])
    const err = await caught(once(f.fetch).getOrder("x"))
    expect(err.reference).toBe(ref)
    expect(err.detail).toBe(`SQLSTATE[HY000] (Print Trail reference ${ref})`)
    expect(err.message).toContain(ref)
  })

  it("has no reference when the body carries none (and keeps one past a long detail)", async () => {
    const ref = "99999999-2222-3333-4444-555555555555"
    const long = fakeFetch([{ status: 500, body: { status: 500, detail: "x".repeat(400), reference: ref } }])
    expect((await caught(once(long.fetch).getOrder("x"))).detail.endsWith(`(Print Trail reference ${ref})`)).toBe(true)
    const f = fakeFetch([{ status: 500, text: "<html>oops</html>" }])
    expect((await caught(once(f.fetch).getOrder("x"))).reference).toBeNull()
  })
})

describe("access refusals (API 1.2.0)", () => {
  const e = (status: number, body: unknown) => new PrintTrailApiError("x", status, body, "GET", "/", "d")
  it("tells a bad token or channel, an inactive channel and other 403s apart", () => {
    expect(e(401, { status: 401, detail: "Unauthenticated." }).accessRefusal).toBe("auth-failed")
    const inactive = e(403, { type: "https://docs.printtrail.com/channel-api/problems/channel-inactive", title: "Channel inactive", status: 403, detail: "This channel is inactive in Print Trail." })
    expect(inactive.isChannelInactive).toBe(true)
    expect(inactive.accessRefusal).toBe("channel-inactive")
    const team = e(403, { type: "about:blank", status: 403, detail: "This team is inactive. Webhooks cannot be registered." })
    expect(team.isChannelInactive).toBe(false)
    expect(team.accessRefusal).toBeNull()
    expect(e(503, null).accessRefusal).toBeNull()
  })
})

describe("429 Retry-After (API 1.2.0)", () => {
  const limited = (retryAfter?: string) => ({
    status: 429,
    body: { type: "about:blank", title: "Too Many Requests", status: 429, detail: "Too many requests." },
    headers: {
      ...(retryAfter !== undefined ? { "Retry-After": retryAfter } : {}),
      "X-RateLimit-Limit": "600",
      "X-RateLimit-Remaining": "0",
    },
  })
  const make = (f: typeof fetch, extra: Partial<ConstructorParameters<typeof PrintTrailClient>[0]> = {}) =>
    new PrintTrailClient({ baseUrl: "https://pt.example", channelId: "c", apiToken: TOKEN, fetch: f, retryDelays: [0, 0, 0], ...extra })

  it("waits the Retry-After seconds when they fit in the retry delays, then retries", async () => {
    const f = fakeFetch([limited("1"), { status: 200, body: { data: order } }])
    const started = Date.now()
    await expect(make(f.fetch, { retryDelays: [500, 500] }).getOrder("ord-1")).resolves.toEqual(order)
    expect(Date.now() - started).toBeGreaterThanOrEqual(950)
    expect(f.calls).toHaveLength(2)
  })

  it("sleeps off a pause's last few milliseconds even with the wait budget spent", async () => {
    // A timer firing just before `until` leaves this; it isn't a new pause.
    const f = fakeFetch([{ status: 200, body: { data: order } }])
    const gate = { until: Date.now() + 40 }
    await expect(make(f.fetch, { retryDelays: [], rateLimitGate: gate }).getOrder("ord-1")).resolves.toEqual(order)
    expect(f.calls).toHaveLength(1)
  })

  it("fails at once, as transient, when Retry-After is longer than it will wait", async () => {
    // The default delays: 7 s in all.
    const f = fakeFetch([limited("60")])
    const err = await caught(make(f.fetch, { retryDelays: undefined }).getOrder("ord-1"))
    expect(f.calls).toHaveLength(1)
    expect(err.status).toBe(429)
    expect(err.isTransient).toBe(true)
    expect(err.retryAfterMs).toBe(60_000)
  })

  it("reads an HTTP-date Retry-After", async () => {
    const at = new Date(Date.now() + 120_000).toUTCString()
    const f = fakeFetch([limited(at)])
    const err = await caught(make(f.fetch).getOrder("ord-1"))
    expect(f.calls).toHaveLength(1)
    expect(err.retryAfterMs).toBeGreaterThan(100_000)
    expect(err.retryAfterMs).toBeLessThanOrEqual(120_000)
  })

  it("caps an absurd Retry-After at an hour", async () => {
    const f = fakeFetch([limited("999999")])
    expect((await caught(make(f.fetch).getOrder("ord-1"))).retryAfterMs).toBe(3_600_000)
  })

  it("sends nothing more until the wait is over, across clients sharing the gate", async () => {
    const gate = { until: 0 }
    const f = fakeFetch([limited("60")])
    const a = make(f.fetch, { rateLimitGate: gate })
    const b = make(f.fetch, { rateLimitGate: gate, retryDelays: [] })
    await caught(a.getOrder("ord-1"))
    const second = await caught(a.getToken())
    const third = await caught(b.getChannel())
    expect(f.calls).toHaveLength(1)
    for (const err of [second, third]) {
      expect(err.status).toBe(429)
      expect(err.isTransient).toBe(true)
      expect(err.notSent).toBe(true)
      expect(err.retryAfterMs).toBeGreaterThan(55_000)
      expect(err.detail).toMatch(/rate limit/i)
    }
    // A 429 Print Trail sent is not "not sent".
    expect((await caught(make(fakeFetch([limited("60")]).fetch).getOrder("x"))).notSent).toBe(false)
  })

  it("waits out the rest of a pause that fits its wait budget, then sends", async () => {
    const gate = { until: Date.now() + 300 }
    const f = fakeFetch([{ status: 200, body: { data: order } }])
    // Budget 0: the pause can't fit, so it fails unsent.
    expect((await caught(make(f.fetch, { rateLimitGate: gate, retryDelays: [] }).getOrder("ord-1"))).notSent).toBe(true)
    const started = Date.now()
    await expect(make(f.fetch, { rateLimitGate: gate, retryDelays: [500] }).getOrder("ord-1")).resolves.toEqual(order)
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
    expect(f.calls).toHaveLength(1)
  })

  it("a pause over budget after an attempt was sent is an ordinary, counted failure", async () => {
    const gate = { until: 0 }
    const f = fakeFetch([{ status: 503 }])
    const pausing = (async (url: string, init: RequestInit) => {
      // Another request hears a long Retry-After while this one is in flight.
      gate.until = Date.now() + 60_000
      return f.fetch(url, init)
    }) as typeof fetch
    const err = await caught(make(pausing, { rateLimitGate: gate, retryDelays: [0, 0] }).getOrder("ord-1"))
    expect(f.calls).toHaveLength(1)
    expect(err.isTransient).toBe(true)
    // Print Trail saw attempt 0: the caller must count it.
    expect(err.notSent).toBe(false)
  })

  it("checks the pause on every attempt, not just the first", async () => {
    const gate = { until: 0 }
    const f = fakeFetch([{ status: 503 }, { status: 200, body: { data: order } }])
    const pausing = (async (url: string, init: RequestInit) => {
      // Another request hears a Retry-After while this one is in flight.
      if (f.calls.length === 0) gate.until = Date.now() + 200
      return f.fetch(url, init)
    }) as typeof fetch
    const started = Date.now()
    await expect(make(pausing, { rateLimitGate: gate, retryDelays: [0, 500] }).getOrder("ord-1")).resolves.toEqual(order)
    expect(Date.now() - started).toBeGreaterThanOrEqual(150)
    expect(f.calls).toHaveLength(2)
  })

  it("keeps the fixed delays for a 429 without Retry-After (an older Print Trail API)", async () => {
    const f = fakeFetch([limited(), limited(), { status: 200, body: { data: order } }])
    await expect(make(f.fetch).getOrder("ord-1")).resolves.toEqual(order)
    expect(f.calls).toHaveLength(3)
  })

  it("never retries a 401, so failed requests don't add up against the per-IP limit", async () => {
    const f = fakeFetch([{ status: 401, body: { status: 401, title: "Unauthorized", detail: "Unauthenticated." } }])
    const err = await caught(make(f.fetch).getOrder("ord-1"))
    expect(f.calls).toHaveLength(1)
    expect(err.isTransient).toBe(false)
  })
})
