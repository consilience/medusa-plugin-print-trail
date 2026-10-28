import { startMockPrintTrail, type MockPrintTrail } from "../../../../dev/mock-print-trail"
import { PrintTrailFulfillmentService } from "../service"

const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }

const ukStandard = {
  method: "standard",
  currency_code: "gbp",
  bands: [
    { max_weight: 750, prices: { gbp: 2.99 } },
    { max_weight: 2000, prices: { gbp: 4.49 } },
    { max_weight: null, prices: { gbp: 6.99 } },
  ],
}

const items = (grams: number) => [{ id: "item_1", quantity: 1, variant: { weight: grams } }]

let mock: MockPrintTrail

beforeEach(async () => {
  logger.warn.mockClear()
  mock = await startMockPrintTrail({ token: "prov-token", channelId: "acme-medusa1" })
})
afterEach(() => mock.close())

const provider = (options: Record<string, string | undefined>) =>
  new PrintTrailFulfillmentService({ logger } as any, options)

describe("PrintTrailFulfillmentService", () => {
  it("has the print-trail identifier", () => {
    expect(PrintTrailFulfillmentService.identifier).toBe("print-trail")
  })

  it("offers the channel's shipping methods", async () => {
    const p = provider({ baseUrl: mock.url, channelId: "acme-medusa1", apiToken: "prov-token" })
    const options = await p.getFulfillmentOptions()
    expect(options).toEqual([
      { id: "standard", name: "Standard", method: "standard" },
      { id: "express", name: "Express (Tracked)", method: "express" },
      { id: "air", name: "Air Express (Tracked)", method: "air" },
      { id: "tracked", name: "Tracked", method: "tracked" },
    ])
  })

  it("uses the production Print Trail API when no base URL is set", async () => {
    const guarded = globalThis.fetch
    const stub = jest.fn(async () => new Response(JSON.stringify([{ code: "standard", name: "Standard" }]), { status: 200 }))
    globalThis.fetch = stub as unknown as typeof fetch
    try {
      const p = provider({ channelId: "acme-medusa1", apiToken: "prov-token" })
      expect(await p.getFulfillmentOptions()).toEqual([{ id: "standard", name: "Standard", method: "standard" }])
      expect(stub).toHaveBeenCalledTimes(1)
      expect((stub.mock.calls[0] as unknown[])[0]).toBe("https://api.printtrail.com/v1/channels/acme-medusa1/shipping-methods")
    } finally {
      globalThis.fetch = guarded
    }
  })

  it("falls back to the four codes without credentials or on failure", async () => {
    const fallback = ["standard", "express", "air", "tracked"]
    const p = provider({})
    expect((await p.getFulfillmentOptions()).map((o) => o.id)).toEqual(fallback)

    mock.fail(/shipping-methods/, 401, { status: 401, title: "Unauthorized", detail: "x", type: "about:blank" })
    const q = provider({ baseUrl: mock.url, channelId: "acme-medusa1", apiToken: "prov-token" })
    expect((await q.getFulfillmentOptions()).map((o) => o.id)).toEqual(fallback)
    expect(logger.warn).toHaveBeenCalled()
  })

  it("prices from the rate card by cart weight", async () => {
    const p = provider({})
    await expect(
      p.calculatePrice(ukStandard, {}, { currency_code: "gbp", items: items(800) } as any)
    ).resolves.toEqual({ calculated_amount: 4.49, is_calculated_price_tax_inclusive: false })
  })

  it("uses the card's currency when the context has none", async () => {
    const p = provider({})
    await expect(
      p.calculatePrice(ukStandard, {}, { items: items(3000) } as any)
    ).resolves.toMatchObject({ calculated_amount: 6.99 })
  })

  it("refuses a weight no band covers", async () => {
    const p = provider({})
    const capped = { ...ukStandard, bands: ukStandard.bands.slice(0, 2) }
    await expect(
      p.calculatePrice(capped, {}, { currency_code: "gbp", items: items(5000) } as any)
    ).rejects.toThrow(/No standard rate/)
  })

  describe("per-country bands", () => {
    // Royal Mail International Tracked: France and Iceland at 250 g.
    const international = {
      method: "standard",
      currency_code: "gbp",
      bands: [
        { max_weight: 250, prices: { gbp: 17.5 } },
        { max_weight: 2000, prices: { gbp: 41.5 } },
      ],
      countries: {
        fr: [
          { max_weight: 250, prices: { gbp: 8.25 } },
          { max_weight: 2000, prices: { gbp: 20 } },
        ],
        is: [
          { max_weight: 250, prices: { gbp: 17.5 } },
          { max_weight: 1000, prices: { gbp: 30 } },
        ],
      },
    }
    const to = (country_code: string | null | undefined, grams: number) =>
      ({ items: items(grams), shipping_address: country_code === undefined ? undefined : country_code === null ? null : { country_code } }) as any

    it("prices a listed destination from its own bands", async () => {
      const p = provider({})
      await expect(p.calculatePrice(international, {}, to("fr", 250))).resolves.toMatchObject({ calculated_amount: 8.25 })
      await expect(p.calculatePrice(international, {}, to("FR", 251))).resolves.toMatchObject({ calculated_amount: 20 })
    })

    it("prices any other destination, or none, from the default bands", async () => {
      const p = provider({})
      await expect(p.calculatePrice(international, {}, to("de", 250))).resolves.toMatchObject({ calculated_amount: 17.5 })
      await expect(p.calculatePrice(international, {}, to(null, 250))).resolves.toMatchObject({ calculated_amount: 17.5 })
      await expect(p.calculatePrice(international, {}, to(undefined, 251))).resolves.toMatchObject({ calculated_amount: 41.5 })
      await expect(p.calculatePrice(international, {}, { items: items(250), shipping_address: {} } as any)).resolves.toMatchObject({
        calculated_amount: 17.5,
      })
      for (const code of ["constructor", "__proto__"]) {
        await expect(p.calculatePrice(international, {}, to(code, 250))).resolves.toMatchObject({ calculated_amount: 17.5 })
      }
    })

    it("refuses a weight above the destination's last band, naming the country", async () => {
      const p = provider({})
      // Iceland stops at 1 kg though the default goes to 2 kg.
      await expect(p.calculatePrice(international, {}, to("is", 1500))).rejects.toMatchObject({
        type: "not_allowed",
        message: expect.stringMatching(/Iceland/),
      })
      await expect(p.calculatePrice(international, {}, to("fr", 2000))).resolves.toMatchObject({ calculated_amount: 20 })
      await expect(p.calculatePrice(international, {}, to("is", 1000))).resolves.toMatchObject({ calculated_amount: 30 })
      await expect(p.calculatePrice(international, {}, to("fr", 2001))).rejects.toThrow(/No standard rate for 2001 g to France/)
      await expect(p.calculatePrice(international, {}, to("de", 2001))).rejects.toMatchObject({ type: "not_allowed" })
    })

    // Over the cap on the cart's option listing (adding a method, the cart
    // refresh): no price, so Medusa refuses the add and drops a chosen
    // method instead of failing the cart update. /calculate still throws.
    it("gives no price over the cap when the cart's options are listed", async () => {
      const p = provider({})
      const listing = { sales_channel_id: "sc_1", currency_code: "gbp", region_id: "reg_1", item_total: 40, total: 40 }
      const over = await p.calculatePrice(international, {}, { ...to("fr", 2400), ...listing })
      expect(over).toEqual({ is_calculated_price_tax_inclusive: false })
      expect("calculated_amount" in over).toBe(false)
      expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/No standard rate for 2400 g to France in GBP/))
      // Under the cap, the listing prices as usual.
      await expect(p.calculatePrice(international, {}, { ...to("fr", 2000), ...listing })).resolves.toEqual({
        calculated_amount: 20,
        is_calculated_price_tax_inclusive: false,
      })
      // Without the listing's fields it throws, as on /calculate.
      await expect(
        p.calculatePrice(international, {}, { ...to("fr", 2400), currency_code: "gbp", region_id: "reg_1" })
      ).rejects.toMatchObject({ type: "not_allowed" })
    })

    it("prices a card without countries the same whatever the destination", async () => {
      const p = provider({})
      await expect(p.calculatePrice(ukStandard, {}, to("fr", 800))).resolves.toMatchObject({ calculated_amount: 4.49 })
    })
  })

  it("refuses a malformed rate card", async () => {
    const p = provider({})
    await expect(p.validateOption({ method: "standard" })).rejects.toThrow()
    await expect(p.validateOption(ukStandard)).resolves.toBe(true)
  })

  it("copies the method onto the shipping method data", async () => {
    const p = provider({})
    await expect(
      p.validateFulfillmentData({ method: "tracked" }, { foo: 1 }, {} as any)
    ).resolves.toEqual({ foo: 1, method: "tracked" })
  })

  it("never calls Print Trail when Medusa creates a fulfilment", async () => {
    const p = provider({ baseUrl: mock.url, channelId: "acme-medusa1", apiToken: "prov-token" })
    await expect(p.createFulfillment()).resolves.toEqual({
      data: {},
      labels: [],
    })
    await expect(p.cancelFulfillment()).resolves.toEqual({})
    expect(mock.state.requests).toHaveLength(0)
  })
})
