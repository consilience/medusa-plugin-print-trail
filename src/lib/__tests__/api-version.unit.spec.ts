import { API_VERSION_STATE_KEY, createApiVersionTracker } from "../api-version"

const NOW = new Date("2026-10-19T12:00:00Z")
const flush = () => new Promise((r) => setTimeout(r, 10))

const memory = (initial: Record<string, unknown> = {}) => {
  const map = new Map<string, unknown>(Object.entries(initial))
  const writes: unknown[] = []
  let reads = 0
  return {
    map,
    writes,
    reads: () => reads,
    fail: false,
    async getState<T>(key: string): Promise<T | null> {
      reads++
      return (map.get(key) as T | undefined) ?? null
    },
    async setState(key: string, value: unknown) {
      if (this.fail) throw new Error("db down")
      writes.push(value)
      map.set(key, value)
    },
  }
}

describe("createApiVersionTracker", () => {
  it("stores the version only when it changes", async () => {
    const state = memory()
    const track = createApiVersionTracker(state, null, () => NOW)
    track("1.1.0", "/")
    track("1.1.0", "/orders")
    await flush()
    track("1.1.0", "/token")
    await flush()
    expect(state.writes).toEqual([{ version: "1.1.0", seenAt: NOW.toISOString() }])
    track("1.2.0", "/")
    await flush()
    expect(state.map.get(API_VERSION_STATE_KEY)).toEqual({ version: "1.2.0", seenAt: NOW.toISOString() })
    expect(state.writes).toHaveLength(2)
    // The stored row is read once.
    expect(state.reads()).toBe(1)
  })

  it("reads what another process stored, and writes nothing when it matches", async () => {
    const state = memory({ [API_VERSION_STATE_KEY]: { version: "1.2.0", seenAt: "earlier" } })
    createApiVersionTracker(state, null, () => NOW)("1.2.0", "/")
    await flush()
    expect(state.writes).toEqual([])
  })

  it("a failed write is logged and tried again on the next response", async () => {
    const state = memory()
    const warnings: string[] = []
    const track = createApiVersionTracker(state, { warn: (m) => warnings.push(m) }, () => NOW)
    state.fail = true
    track("1.2.0", "/")
    await flush()
    expect(warnings).toEqual([expect.stringMatching(/couldn't record the Print Trail API version: db down/)])
    state.fail = false
    track("1.2.0", "/")
    await flush()
    expect(state.writes).toEqual([{ version: "1.2.0", seenAt: NOW.toISOString() }])
  })
})
