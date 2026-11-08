import { resolvePluginOptions } from "../../config"
import type { SettingKey, SettingRecord } from "../settings"
import { EffectiveOptions, SETTINGS_CACHE_MS } from "../settings-cache"

const at = "2026-11-08T12:00:00.000Z"
const config = resolvePluginOptions({ orderNumberPrefix: "ORD-" })

function setup() {
  let now = Date.parse(at)
  let records: Partial<Record<SettingKey, SettingRecord>> = {}
  let failing = false
  let reads = 0
  const cache = new EffectiveOptions({
    config,
    now: () => now,
    read: async () => {
      reads++
      if (failing) throw new Error("db down")
      return records
    },
  })
  return {
    cache,
    advance: (ms: number) => (now += ms),
    save: (r: Partial<Record<SettingKey, SettingRecord>>) => (records = { ...records, ...r }),
    fail: (on: boolean) => (failing = on),
    reads: () => reads,
  }
}

const prefix = (value: string): Partial<Record<SettingKey, SettingRecord>> => ({
  orderNumberPrefix: { overridden: true, value, changed_by: null, changed_at: at },
})

describe("EffectiveOptions", () => {
  it("reads the settings once per cache lifetime", async () => {
    const t = setup()
    await t.cache.get()
    await t.cache.get()
    expect(t.reads()).toBe(1)
    t.advance(SETTINGS_CACHE_MS)
    await t.cache.get()
    expect(t.reads()).toBe(2)
  })

  it("another process's save is seen once the cached options are 5 seconds old", async () => {
    const t = setup()
    expect((await t.cache.get()).orderNumberPrefix).toBe("ORD-")
    t.save(prefix("WEB-"))
    t.advance(SETTINGS_CACHE_MS - 1)
    expect((await t.cache.get()).orderNumberPrefix).toBe("ORD-")
    t.advance(1)
    expect((await t.cache.get()).orderNumberPrefix).toBe("WEB-")
  })

  it("a save in this process is seen at once", async () => {
    const t = setup()
    await t.cache.get()
    t.save(prefix(""))
    t.cache.clear()
    expect((await t.cache.get()).orderNumberPrefix).toBe("")
  })

  it("a failed read keeps the options read before, never the plugin options", async () => {
    const t = setup()
    t.save(prefix("WEB-"))
    await t.cache.get()
    t.fail(true)
    t.advance(60_000)
    expect((await t.cache.get()).orderNumberPrefix).toBe("WEB-")
  })

  it("a read that started before a save's clear isn't cached", async () => {
    let release: () => void = () => {}
    let records: Partial<Record<SettingKey, SettingRecord>> = {}
    let slow = true
    const cache = new EffectiveOptions({
      config,
      now: () => Date.parse(at),
      read: async () => {
        const seen = records
        if (slow) await new Promise<void>((r) => (release = r))
        return seen
      },
    })
    const stale = cache.get()
    // A save lands while the read is in flight, and clears the cache.
    records = prefix("WEB-")
    cache.clear()
    release()
    expect((await stale).orderNumberPrefix).toBe("ORD-")
    slow = false
    expect((await cache.get()).orderNumberPrefix).toBe("WEB-")
  })

  it("a failed read after a clear still keeps the options read before", async () => {
    const t = setup()
    t.save(prefix("WEB-"))
    await t.cache.get()
    t.cache.clear()
    t.fail(true)
    expect((await t.cache.get()).orderNumberPrefix).toBe("WEB-")
  })

  it("fresh() reads past the cache, and refreshes it", async () => {
    const t = setup()
    await t.cache.get()
    t.save(prefix("WEB-"))
    expect((await t.cache.fresh()).orderNumberPrefix).toBe("WEB-")
    expect((await t.cache.get()).orderNumberPrefix).toBe("WEB-")
    expect(t.reads()).toBe(2)
  })

  it("fresh() throws on a failed read, never answering with the options read before", async () => {
    const t = setup()
    t.save({ confirmOn: { overridden: true, value: "order.placed", changed_by: null, changed_at: at } })
    expect((await t.cache.get()).confirmOn).toBe("order.placed")
    // Switched to confirming on payment in the admin; then the database fails.
    t.save({ confirmOn: { overridden: true, value: "payment.captured", changed_by: null, changed_at: at } })
    t.fail(true)
    await expect(t.cache.fresh()).rejects.toThrow("db down")
    // get() still falls back, for the paths that only read.
    expect((await t.cache.get()).confirmOn).toBe("order.placed")
  })

  it("a failed first read throws", async () => {
    const t = setup()
    t.fail(true)
    await expect(t.cache.get()).rejects.toThrow("db down")
  })
})
