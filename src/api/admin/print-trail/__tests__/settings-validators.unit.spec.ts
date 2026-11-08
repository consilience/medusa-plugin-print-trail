import { PostPrintTrailSettingsSchema, ResetPrintTrailSettingQuerySchema } from "../validators"

const parse = (body: unknown) => PostPrintTrailSettingsSchema.safeParse(body)

describe("PostPrintTrailSettingsSchema", () => {
  it("takes any of the editable settings; a key left out is unchanged", () => {
    const out = parse({ values: { orderNumberPrefix: "", "reconcile.lookbackDays": 30, "notifications.shipment": false } })
    expect(out.success && out.data).toEqual({
      values: { orderNumberPrefix: "", "reconcile.lookbackDays": 30, "notifications.shipment": false },
      confirm: [],
    })
  })

  it("takes confirms by the question they answer, and nothing else", () => {
    expect(parse({ values: {}, confirm: ["prefix-may-repeat", "confirms-awaiting-payment"] }).success).toBe(true)
    expect(parse({ values: {}, confirm: true }).success).toBe(false)
    expect(parse({ values: {}, confirm: ["everything"] }).success).toBe(false)
    expect(ResetPrintTrailSettingQuerySchema.parse({ confirm: "prefix-may-repeat,confirms-awaiting-payment" })).toEqual({
      confirm: ["prefix-may-repeat", "confirms-awaiting-payment"],
    })
    expect(ResetPrintTrailSettingQuerySchema.parse({})).toEqual({ confirm: [] })
    expect(ResetPrintTrailSettingQuerySchema.safeParse({ confirm: "true" }).success).toBe(false)
  })

  it("refuses credentials, deployment URLs and unknown keys", () => {
    for (const key of ["baseUrl", "channelId", "apiToken", "webhookSecret", "backendUrl", "adminUrl", "appUrl", "notifications.render", "extra"]) {
      expect(parse({ values: { [key]: "x" } }).success).toBe(false)
    }
    expect(parse({ values: {}, extra: true }).success).toBe(false)
  })

  it("refuses a bad prefix, lookback, address or confirm-on value", () => {
    expect(parse({ values: { orderNumberPrefix: "ORD 1" } }).success).toBe(false)
    expect(parse({ values: { orderNumberPrefix: "A".repeat(240) } }).success).toBe(false)
    expect(parse({ values: { "reconcile.lookbackDays": 0 } }).success).toBe(false)
    expect(parse({ values: { "reconcile.lookbackDays": "7" } }).success).toBe(false)
    expect(parse({ values: { "notifications.adminEmail": ["ops@"] } }).success).toBe(false)
    expect(parse({ values: { "notifications.adminEmail": "ops@example.com" } }).success).toBe(false)
    expect(parse({ values: { confirmOn: "payment.authorized" } }).success).toBe(false)
    expect(parse({ values: { strictSkus: "yes" } }).success).toBe(false)
  })

  it("a null is not a reset (DELETE resets)", () => {
    expect(parse({ values: { orderNumberPrefix: null } }).success).toBe(false)
  })
})
