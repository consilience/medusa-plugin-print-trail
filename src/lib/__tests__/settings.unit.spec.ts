import { resolvePluginOptions } from "../../config"
import {
  applyOverrides,
  configValue,
  MAX_PREFIX_LENGTH,
  reusedOrderNumbers,
  SETTING_KEYS,
  SETTING_SCHEMAS,
  type SettingRecord,
} from "../settings"

const config = resolvePluginOptions({
  orderNumberPrefix: "ORD-",
  confirmOn: "payment.captured",
  reconcile: { enabled: true, lookbackDays: 7 },
  notifications: { shipment: "my-shipment", adminEmail: "ops@example.com" },
  stockLocationIds: ["sloc_1"],
})

const set = (value: unknown): SettingRecord => ({ overridden: true, value, changed_by: "user_1", changed_at: "2026-11-08T10:00:00Z" })
const reset: SettingRecord = { overridden: false, changed_by: "user_1", changed_at: "2026-11-08T11:00:00Z" }

describe("applyOverrides", () => {
  it("a value saved in the admin wins over the plugin options; without one, the options apply", () => {
    const o = applyOverrides(config, { orderNumberPrefix: set("WEB-"), confirmOn: set("order.placed") })
    expect(o.orderNumberPrefix).toBe("WEB-")
    expect(o.confirmOn).toBe("order.placed")
    expect(o.defaultShippingMethod).toBe("standard")
    expect(o.notifications.shipment).toBe("my-shipment")
  })

  it("a reset setting is the plugin options' value", () => {
    expect(applyOverrides(config, { orderNumberPrefix: reset }).orderNumberPrefix).toBe("ORD-")
  })

  it("an empty prefix saved in the admin is an empty prefix", () => {
    expect(applyOverrides(config, { orderNumberPrefix: set("") }).orderNumberPrefix).toBe("")
  })

  it("a nested setting keeps its siblings", () => {
    const o = applyOverrides(config, {
      "reconcile.lookbackDays": set(30),
      "notifications.cancelTooLate": set(false),
      "notifications.adminEmail": set(["a@example.com", "b@example.com"]),
    })
    expect(o.reconcile).toEqual({ enabled: true, lookbackDays: 30 })
    expect(o.notifications).toEqual({
      shipment: "my-shipment",
      cancelTooLate: false,
      adminEmail: ["a@example.com", "b@example.com"],
      render: true,
    })
  })

  it("an empty stock location list means every location", () => {
    expect(applyOverrides(config, { stockLocationIds: set([]) }).stockLocationIds).toBeUndefined()
    expect(applyOverrides(config, { stockLocationIds: set(["sloc_2"]) }).stockLocationIds).toEqual(["sloc_2"])
  })

  it("ignores a stored value that isn't valid, and says so", () => {
    const warnings: string[] = []
    const o = applyOverrides(config, { confirmOn: set("whenever"), "reconcile.lookbackDays": set(-1) }, (m) => warnings.push(m))
    expect(o.confirmOn).toBe("payment.captured")
    expect(o.reconcile.lookbackDays).toBe(7)
    expect(warnings).toHaveLength(2)
  })

  it("leaves the config untouched", () => {
    applyOverrides(config, { "reconcile.enabled": set(false) })
    expect(config.reconcile.enabled).toBe(true)
  })

  it("reads every key's config value", () => {
    expect(SETTING_KEYS.map((k) => configValue(config, k))).toEqual([
      "ORD-",
      "standard",
      "payment.captured",
      true,
      true,
      true,
      7,
      true,
      "my-shipment",
      "print-trail-cancel-too-late",
      ["ops@example.com"],
      ["sloc_1"],
    ])
  })
})

describe("setting values", () => {
  const ok = (key: keyof typeof SETTING_SCHEMAS, value: unknown) => SETTING_SCHEMAS[key].safeParse(value).success

  it("a prefix is letters, digits and - _ . / #, within the order number limit", () => {
    expect(ok("orderNumberPrefix", "")).toBe(true)
    expect(ok("orderNumberPrefix", "WEB-2026/#_.")).toBe(true)
    expect(ok("orderNumberPrefix", "WEB ")).toBe(false)
    expect(ok("orderNumberPrefix", "WÉB-")).toBe(false)
    expect(ok("orderNumberPrefix", "A".repeat(MAX_PREFIX_LENGTH))).toBe(true)
    expect(ok("orderNumberPrefix", "A".repeat(MAX_PREFIX_LENGTH + 1))).toBe(false)
    // A 10-digit display id and a "-n" sequence still fit in 255.
    expect(MAX_PREFIX_LENGTH + "2147483647".length + "-99999".length).toBe(255)
  })

  it("lookback days are a whole number from 1 to 90", () => {
    expect(ok("reconcile.lookbackDays", 1)).toBe(true)
    expect(ok("reconcile.lookbackDays", 90)).toBe(true)
    expect(ok("reconcile.lookbackDays", 0)).toBe(false)
    expect(ok("reconcile.lookbackDays", 91)).toBe(false)
    expect(ok("reconcile.lookbackDays", 7.5)).toBe(false)
  })

  it("admin email addresses must be valid, and repeats are dropped", () => {
    expect(SETTING_SCHEMAS["notifications.adminEmail"].parse([" ops@example.com ", "ops@example.com"])).toEqual(["ops@example.com"])
    expect(SETTING_SCHEMAS["notifications.adminEmail"].parse(["Ops@Example.com", "ops@example.com", "b@example.com"])).toHaveLength(2)
    expect(ok("notifications.adminEmail", ["not-an-address"])).toBe(false)
    expect(ok("notifications.adminEmail", [])).toBe(true)
  })

  it("a template is an id or false", () => {
    expect(ok("notifications.shipment", false)).toBe(true)
    expect(ok("notifications.shipment", "my-template")).toBe(true)
    expect(ok("notifications.shipment", "")).toBe(false)
    expect(ok("notifications.shipment", true)).toBe(false)
  })

  it("confirm on is order.placed or payment.captured", () => {
    expect(ok("confirmOn", "order.placed")).toBe(true)
    expect(ok("confirmOn", "payment.captured")).toBe(true)
    expect(ok("confirmOn", "order.completed")).toBe(false)
  })
})

describe("reusedOrderNumbers", () => {
  it("dropping a prefix's trailing digits could repeat its numbers", () => {
    // ORD-1 + 500 is ORD-1500, which order 1500 would get under ORD-.
    expect(reusedOrderNumbers("ORD-", [{ pt_order_number: "ORD-1500", display_id: 500 }])).toEqual(["ORD-1500"])
  })

  it("rows numbered under the prefix for their own order are safe", () => {
    expect(
      reusedOrderNumbers("ORD-", [
        { pt_order_number: "ORD-12", display_id: 12 },
        { pt_order_number: "ORD-12-2", display_id: 12 },
        { pt_order_number: "WEB-12", display_id: 12 },
      ])
    ).toEqual([])
  })

  it("an empty prefix is checked against every number of digits", () => {
    expect(
      reusedOrderNumbers("", [
        { pt_order_number: "1-5", display_id: 5 },
        { pt_order_number: "7", display_id: 7 },
        { pt_order_number: "ORD-7", display_id: 7 },
      ])
    ).toEqual(["1-5"])
  })

  it("a prefix's own characters are taken literally", () => {
    expect(reusedOrderNumbers("A.", [{ pt_order_number: "AB12", display_id: 3 }])).toEqual([])
  })

  it("ignores case", () => {
    expect(reusedOrderNumbers("ord-", [{ pt_order_number: "ORD-1500", display_id: 500 }])).toEqual(["ORD-1500"])
  })
})
