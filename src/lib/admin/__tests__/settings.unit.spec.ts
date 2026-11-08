import { resolvePluginOptions, type PrintTrailPluginOptions } from "../../../config"
import { applyOverrides, type SettingKey, type SettingRecord } from "../../settings"
import { findReusedOrderNumbers, saveSettings, settingsView, type OrderNumberRow, type SettingsDeps } from "../settings"

const NOW = new Date("2026-11-08T12:00:00Z")

class MemorySettings {
  records: Partial<Record<SettingKey, SettingRecord>> = {}
  writes = 0
  constructor(private config: PrintTrailPluginOptions) {}
  async getConfigOptions() {
    return this.config
  }
  // What a process's cache might hold: the plugin options, whatever was
  // saved since. The view and the save's checks must never read it.
  async getOptions() {
    return this.config
  }
  async effective() {
    return applyOverrides(this.config, this.records)
  }
  async readSettingRecords() {
    return { ...this.records }
  }
  async writeSettingRecords(records: Partial<Record<SettingKey, SettingRecord>>) {
    this.writes++
    Object.assign(this.records, records)
  }
}

function deps(
  store: MemorySettings,
  over: {
    rows?: OrderNumberRow[]
    displayIds?: Record<string, number>
    methods?: string[]
    methodsSource?: "print-trail" | "fallback"
    awaiting?: number
  } = {}
): SettingsDeps & { logged: string[]; warned: string[]; pages: number; lookbacks: number[] } {
  const logged: string[] = []
  const warned: string[] = []
  const out = {
    store,
    logged,
    warned,
    pages: 0,
    lookbacks: [] as number[],
    logger: { info: (m: string) => logged.push(m), warn: (m: string) => warned.push(m) },
    now: () => NOW,
    methods: async () => ({
      methods: (over.methods ?? ["standard", "express"]).map((code) => ({ code, name: code.toUpperCase() })),
      source: over.methodsSource ?? ("print-trail" as const),
    }),
    stockLocations: async () => [
      { id: "sloc_1", name: "Warehouse" },
      { id: "sloc_2", name: null },
    ],
    users: async (ids: string[]) => ids.filter((id) => id === "user_1").map((id) => ({ id, email: "admin@example.com", name: "Ada Admin" })),
    async orderNumberPage(prefix: string, after: string | null, take: number) {
      out.pages++
      return (over.rows ?? [])
        .filter((r) => r.pt_order_number?.toLowerCase().startsWith(prefix.toLowerCase()) && (after === null || r.id > after))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, take)
    },
    displayIds: async (ids: string[]) => new Map(ids.map((id) => [id, over.displayIds?.[id] ?? null])),
    async awaitingPaymentCount(lookbackDays: number) {
      out.lookbacks.push(lookbackDays)
      return over.awaiting ?? 0
    },
  }
  return out
}

const config = resolvePluginOptions({ orderNumberPrefix: "ORD-", confirmOn: "order.placed" })

describe("saveSettings", () => {
  it("saves each setting with who changed it and when", async () => {
    const store = new MemorySettings(config)
    const d = deps(store)
    const out = await saveSettings(d, { values: { autoComplete: false, "reconcile.lookbackDays": 14 }, actor_id: "user_1" })
    expect(out).toEqual({ status: "saved", keys: ["reconcile.lookbackDays", "autoComplete"], warnings: [] })
    expect(store.records.autoComplete).toEqual({ overridden: true, value: false, changed_by: "user_1", changed_at: NOW.toISOString() })
    expect((await store.effective()).reconcile.lookbackDays).toBe(14)
    expect(d.logged.join("\n")).toMatch(/by user_1: reconcile\.lookbackDays, autoComplete/)
  })

  it("a reset goes back to the plugin options, and records who reset it", async () => {
    const store = new MemorySettings(config)
    await saveSettings(deps(store), { values: { confirmOn: "payment.captured" }, actor_id: "user_1" })
    expect((await store.effective()).confirmOn).toBe("payment.captured")
    await saveSettings(deps(store), { reset: ["confirmOn"], actor_id: "user_2" })
    expect((await store.effective()).confirmOn).toBe("order.placed")
    expect(store.records.confirmOn).toEqual({ overridden: false, changed_by: "user_2", changed_at: NOW.toISOString(), placed_since: NOW.toISOString() })
  })

  it("refuses a shipping method Print Trail doesn't offer, and a stock location that doesn't exist", async () => {
    const store = new MemorySettings(config)
    const out = await saveSettings(deps(store), { values: { defaultShippingMethod: "teleport", stockLocationIds: ["sloc_1", "sloc_9"] } })
    expect(out).toEqual({
      status: "invalid",
      issues: [
        { key: "defaultShippingMethod", message: expect.stringContaining('"teleport"') },
        { key: "stockLocationIds", message: "No stock location sloc_9" },
      ],
    })
    expect(store.writes).toBe(0)
  })

  it("accepts a shipping method Print Trail offers", async () => {
    const store = new MemorySettings(config)
    expect(await saveSettings(deps(store), { values: { defaultShippingMethod: "express" } })).toMatchObject({ status: "saved" })
  })

  it("a prefix that could repeat an order number already sent needs a confirm", async () => {
    const store = new MemorySettings(resolvePluginOptions({ orderNumberPrefix: "ORD-1" }))
    const rows = [{ id: "ptord_1", order_id: "order_500", pt_order_number: "ORD-1500" }]
    const d = deps(store, { rows, displayIds: { order_500: 500 } })
    expect(await saveSettings(d, { values: { orderNumberPrefix: "ORD-" } })).toEqual({
      status: "needs-confirmation",
      reason: "prefix-may-repeat",
      numbers: ["ORD-1500"],
      partial: false,
    })
    expect(store.writes).toBe(0)
    expect(await saveSettings(d, { values: { orderNumberPrefix: "ORD-" }, confirm: ["prefix-may-repeat"] })).toMatchObject({ status: "saved" })
    expect((await store.effective()).orderNumberPrefix).toBe("ORD-")
  })

  it("resetting the prefix checks the plugin options' prefix, and asks the same way", async () => {
    const store = new MemorySettings(resolvePluginOptions({ orderNumberPrefix: "" }))
    const rows = [{ id: "ptord_1", order_id: "order_500", pt_order_number: "1500" }]
    const d = deps(store, { rows, displayIds: { order_500: 500 } })
    expect(await saveSettings(d, { values: { orderNumberPrefix: "WEB-" }, actor_id: "user_1" })).toMatchObject({ status: "saved" })
    expect(await saveSettings(d, { reset: ["orderNumberPrefix"] })).toEqual({
      status: "needs-confirmation",
      reason: "prefix-may-repeat",
      numbers: ["1500"],
      partial: false,
    })
    expect((await store.effective()).orderNumberPrefix).toBe("WEB-")
    expect(await saveSettings(d, { reset: ["orderNumberPrefix"], confirm: ["prefix-may-repeat"] })).toMatchObject({ status: "saved" })
    expect((await store.effective()).orderNumberPrefix).toBe("")
  })

  it("the repeat check ignores case", async () => {
    const store = new MemorySettings(config)
    const rows = [{ id: "ptord_1", order_id: "order_99", pt_order_number: "WEB-12" }]
    const d = deps(store, { rows, displayIds: { order_99: 99 } })
    expect(await saveSettings(d, { values: { orderNumberPrefix: "web-" } })).toEqual({
      status: "needs-confirmation",
      reason: "prefix-may-repeat",
      numbers: ["WEB-12"],
      partial: false,
    })
  })

  it("compares the prefix with the one saved now, not a process's cached options", async () => {
    const store = new MemorySettings(config)
    const rows = [{ id: "ptord_1", order_id: "order_7", pt_order_number: "WEB-12" }]
    const d = deps(store, { rows, displayIds: { order_7: 7 } })
    expect(await saveSettings(d, { values: { orderNumberPrefix: "WEB-" }, confirm: ["prefix-may-repeat"] })).toMatchObject({ status: "saved" })
    // The cache still reads ORD-; WEB- is already in force, so nothing to ask.
    expect(await saveSettings(d, { values: { orderNumberPrefix: "WEB-" } })).toMatchObject({ status: "saved" })
  })

  it("while Print Trail can't be reached, the method in force is accepted, and another is saved with a warning", async () => {
    const store = new MemorySettings(resolvePluginOptions({ defaultShippingMethod: "standard" }))
    const d = deps(store, { methodsSource: "fallback", methods: ["standard", "express"] })
    expect(await saveSettings(d, { values: { defaultShippingMethod: "standard" } })).toEqual({
      status: "saved",
      keys: ["defaultShippingMethod"],
      warnings: [],
    })
    const out = await saveSettings(d, { values: { defaultShippingMethod: "courier-48" } })
    expect(out).toMatchObject({ status: "saved", warnings: [expect.stringContaining('"courier-48" wasn\'t checked')] })
    expect((await store.effective()).defaultShippingMethod).toBe("courier-48")
    expect(d.warned).toHaveLength(1)
  })

  it("switching to confirming when placed asks first, with how many orders waiting for payment it confirms", async () => {
    const store = new MemorySettings(resolvePluginOptions({ confirmOn: "payment.captured" }))
    const d = deps(store, { awaiting: 3 })
    expect(await saveSettings(d, { values: { confirmOn: "order.placed", "reconcile.lookbackDays": 30 } })).toEqual({
      status: "needs-confirmation",
      reason: "confirms-awaiting-payment",
      count: 3,
    })
    expect(d.lookbacks).toEqual([30])
    expect(store.writes).toBe(0)
    expect(await saveSettings(d, { values: { confirmOn: "order.placed" }, confirm: ["confirms-awaiting-payment"] })).toMatchObject({ status: "saved" })
    expect((await store.effective()).confirmOn).toBe("order.placed")
  })

  it("a reset that switches to confirming when placed asks too; with no order waiting, nothing is asked", async () => {
    const store = new MemorySettings(config)
    await saveSettings(deps(store), { values: { confirmOn: "payment.captured" } })
    expect(await saveSettings(deps(store, { awaiting: 1 }), { reset: ["confirmOn"] })).toMatchObject({
      reason: "confirms-awaiting-payment",
      count: 1,
    })
    expect(await saveSettings(deps(store, { awaiting: 0 }), { reset: ["confirmOn"] })).toMatchObject({ status: "saved" })
    expect((await store.effective()).confirmOn).toBe("order.placed")
  })

  it("each confirm covers only its own question", async () => {
    const store = new MemorySettings(resolvePluginOptions({ orderNumberPrefix: "ORD-1", confirmOn: "payment.captured" }))
    const rows = [{ id: "ptord_1", order_id: "order_500", pt_order_number: "ORD-1500" }]
    const d = deps(store, { rows, displayIds: { order_500: 500 }, awaiting: 2 })
    const values = { orderNumberPrefix: "ORD-", confirmOn: "order.placed" as const }
    expect(await saveSettings(d, { values })).toMatchObject({ reason: "prefix-may-repeat" })
    expect(await saveSettings(d, { values, confirm: ["prefix-may-repeat"] })).toMatchObject({ reason: "confirms-awaiting-payment", count: 2 })
    expect(await saveSettings(d, { values, confirm: ["confirms-awaiting-payment"] })).toMatchObject({ reason: "prefix-may-repeat" })
    expect(store.writes).toBe(0)
    expect(await saveSettings(d, { values, confirm: ["prefix-may-repeat", "confirms-awaiting-payment"] })).toMatchObject({ status: "saved" })
  })

  it("records when the admin switched to confirming when placed, keeps it while it stays, and drops it on a switch back", async () => {
    const store = new MemorySettings(resolvePluginOptions({ confirmOn: "payment.captured" }))
    const later = new Date(NOW.getTime() + 60_000)
    await saveSettings(deps(store), { values: { confirmOn: "order.placed" } })
    expect(store.records.confirmOn).toMatchObject({ overridden: true, value: "order.placed", placed_since: NOW.toISOString() })
    // Saved again unchanged: the switch's time stays.
    await saveSettings({ ...deps(store), now: () => later }, { values: { confirmOn: "order.placed" } })
    expect(store.records.confirmOn?.placed_since).toBe(NOW.toISOString())
    await saveSettings(deps(store), { values: { confirmOn: "payment.captured" } })
    expect(store.records.confirmOn?.placed_since).toBeUndefined()
    // A reset to a config that confirms when placed is a switch too.
    const placedConfig = new MemorySettings(config)
    await saveSettings(deps(placedConfig), { values: { confirmOn: "payment.captured" } })
    await saveSettings({ ...deps(placedConfig), now: () => later }, { reset: ["confirmOn"] })
    expect(placedConfig.records.confirmOn).toEqual({ overridden: false, changed_by: null, changed_at: later.toISOString(), placed_since: later.toISOString() })
  })

  it("a prefix with no number it could repeat saves at once, and an unchanged prefix isn't checked", async () => {
    const store = new MemorySettings(config)
    const rows = [{ id: "ptord_1", order_id: "order_12", pt_order_number: "ORD-12" }]
    const d = deps(store, { rows, displayIds: { order_12: 12 } })
    expect(await saveSettings(d, { values: { orderNumberPrefix: "WEB-" } })).toMatchObject({ status: "saved" })
    const pages = d.pages
    expect(await saveSettings(d, { values: { orderNumberPrefix: "WEB-" } })).toMatchObject({ status: "saved" })
    expect(d.pages).toBe(pages)
  })
})

describe("findReusedOrderNumbers", () => {
  it("reads at most 20 pages, and says the result is partial; a save then asks", async () => {
    const rows = Array.from({ length: 10_001 }, (_, i) => ({
      id: `ptord_${String(i).padStart(6, "0")}`,
      order_id: `order_${i}`,
      pt_order_number: `ORD-${i + 1}`,
    }))
    const d = deps(new MemorySettings(config), { rows, displayIds: Object.fromEntries(rows.map((r, i) => [r.order_id, i + 1])) })
    expect(await findReusedOrderNumbers(d, "")).toEqual({ numbers: [], partial: true })
    expect(d.pages).toBe(20)
    expect(await saveSettings(d, { values: { orderNumberPrefix: "" } })).toEqual({
      status: "needs-confirmation",
      reason: "prefix-may-repeat",
      numbers: [],
      partial: true,
    })
  })

  it("pages through every row, and stops at five examples", async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => ({
      id: `ptord_${String(i).padStart(5, "0")}`,
      order_id: `order_${i}`,
      pt_order_number: `${i + 1}`,
    }))
    const safe = deps(new MemorySettings(config), { rows, displayIds: Object.fromEntries(rows.map((r, i) => [r.order_id, i + 1])) })
    expect(await findReusedOrderNumbers(safe, "")).toEqual({ numbers: [], partial: false })
    expect(safe.pages).toBe(3)
    const unsafe = deps(new MemorySettings(config), { rows })
    expect((await findReusedOrderNumbers(unsafe, "")).numbers).toHaveLength(5)
    expect(unsafe.pages).toBe(1)
  })
})

describe("settingsView", () => {
  it("shows each value, the config's, where it comes from, and who changed it", async () => {
    const store = new MemorySettings(config)
    await saveSettings(deps(store), { values: { orderNumberPrefix: "WEB-" }, actor_id: "user_1" })
    await saveSettings(deps(store), { reset: ["autoComplete"], actor_id: "user_gone" })
    const view = await settingsView(deps(store))
    const by = (key: string) => view.settings.find((s) => s.key === key)
    expect(by("orderNumberPrefix")).toEqual({
      key: "orderNumberPrefix",
      value: "WEB-",
      config: "ORD-",
      source: "admin",
      changed_at: NOW.toISOString(),
      changed_by: { id: "user_1", email: "admin@example.com", name: "Ada Admin" },
    })
    expect(by("autoComplete")).toMatchObject({ value: true, source: "config", changed_by: { id: "user_gone", email: null, name: null } })
    expect(by("confirmOn")).toMatchObject({ source: "config", changed_at: null, changed_by: null })
    expect(view.settings).toHaveLength(12)
    expect(view.choices.stockLocations).toHaveLength(2)
    expect(view.limits.prefixMaxLength).toBe(239)
  })

  it("shows a stored value that no longer parses as ignored, with the plugin options' value in force", async () => {
    const store = new MemorySettings(config)
    store.records.orderNumberPrefix = { overridden: true, value: "no spaces allowed", changed_by: "user_1", changed_at: NOW.toISOString() }
    store.records["reconcile.lookbackDays"] = { overridden: true, value: 14, changed_by: "user_1", changed_at: NOW.toISOString() }
    const view = await settingsView(deps(store))
    const by = (key: string) => view.settings.find((s) => s.key === key)
    expect(by("orderNumberPrefix")).toMatchObject({ value: "ORD-", config: "ORD-", source: "ignored" })
    // Read from the records, not the (stale) cached options.
    expect(by("reconcile.lookbackDays")).toMatchObject({ value: 14, source: "admin" })
  })
})
