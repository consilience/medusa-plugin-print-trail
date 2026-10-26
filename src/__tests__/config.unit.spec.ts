import {
  isConnected,
  printTrailOptionsFromEnv,
  resolvePluginOptions,
  STAGING_HOST,
} from "../config"

describe("printTrailOptionsFromEnv", () => {
  it("reads and trims the three credentials", () => {
    expect(
      printTrailOptionsFromEnv({
        PRINT_TRAIL_BASE_URL: " https://pt.example/ ",
        PRINT_TRAIL_CHANNEL_ID: "acme-medusa1",
        PRINT_TRAIL_API_TOKEN: " tok ",
      })
    ).toEqual({
      baseUrl: "https://pt.example",
      channelId: "acme-medusa1",
      apiToken: "tok",
    })
  })

  it("treats empty strings as unset", () => {
    expect(
      printTrailOptionsFromEnv({ PRINT_TRAIL_BASE_URL: "", PRINT_TRAIL_API_TOKEN: "  " })
    ).toEqual({ baseUrl: undefined, channelId: undefined, apiToken: undefined })
  })
})

describe("resolvePluginOptions", () => {
  it("applies the documented defaults", () => {
    expect(resolvePluginOptions(undefined)).toEqual({
      baseUrl: undefined,
      channelId: undefined,
      apiToken: undefined,
      webhookSecret: undefined,
      backendUrl: undefined,
      adminUrl: undefined,
      appUrl: undefined,
      orderNumberPrefix: "",
      defaultShippingMethod: "standard",
      confirmOn: "order.placed",
      strictSkus: true,
      stockSync: { enabled: true },
      reconcile: { enabled: true, lookbackDays: 7 },
      autoComplete: true,
      notifications: { shipment: "print-trail-shipment", cancelTooLate: "print-trail-cancel-too-late", adminEmail: [], render: true },
      stockLocationIds: undefined,
    })
  })

  it("keeps given values, including false toggles", () => {
    const o = resolvePluginOptions({
      orderNumberPrefix: "ORD-",
      strictSkus: false,
      stockSync: { enabled: false },
      reconcile: { enabled: false, lookbackDays: 3 },
      notifications: { shipment: false },
      confirmOn: "payment.captured",
    })
    expect(o.orderNumberPrefix).toBe("ORD-")
    expect(o.strictSkus).toBe(false)
    expect(o.stockSync.enabled).toBe(false)
    expect(o.reconcile).toEqual({ enabled: false, lookbackDays: 3 })
    expect(o.notifications.shipment).toBe(false)
    expect(o.confirmOn).toBe("payment.captured")
  })

  it("reads true as on with the default template", () => {
    const o = resolvePluginOptions({ notifications: { shipment: true, cancelTooLate: true } })
    expect(o.notifications).toMatchObject({ shipment: "print-trail-shipment", cancelTooLate: "print-trail-cancel-too-late" })
    expect(resolvePluginOptions({ notifications: { shipment: "my-shipment" } }).notifications.shipment).toBe("my-shipment")
  })

  it("fails loudly when credentials are set without a base URL", () => {
    expect(() => resolvePluginOptions({ channelId: "acme-medusa1", apiToken: "tok" })).toThrow(
      STAGING_HOST
    )
  })

  it("is not connected, and does not throw, with no credentials", () => {
    const o = resolvePluginOptions({})
    expect(isConnected(o)).toBe(false)
  })

  it("strips a trailing slash from the base URL", () => {
    const o = resolvePluginOptions({
      baseUrl: "https://pt.example//",
      channelId: "c",
      apiToken: "t",
    })
    expect(o.baseUrl).toBe("https://pt.example")
    expect(isConnected(o)).toBe(true)
  })

  it("trims appUrl and strips its trailing slash", () => {
    expect(resolvePluginOptions({ appUrl: "  https://app.custom/ " }).appUrl).toBe("https://app.custom")
  })

  it("defaults the cancel-too-late template and keeps false", () => {
    expect(resolvePluginOptions({}).notifications.cancelTooLate).toBe("print-trail-cancel-too-late")
    expect(resolvePluginOptions({ notifications: { cancelTooLate: false } as never }).notifications.cancelTooLate).toBe(false)
  })

  it("splits, trims and drops empty admin emails", () => {
    const of = (adminEmail: unknown) =>
      resolvePluginOptions({ notifications: { adminEmail } as never }).notifications.adminEmail
    expect(of(" a@x.test, ,b@x.test ")).toEqual(["a@x.test", "b@x.test"])
    expect(of([" a@x.test ", "", "b@x.test"])).toEqual(["a@x.test", "b@x.test"])
    expect(of(undefined)).toEqual([])
  })
})
