import { startMockPrintTrail, type MockPrintTrail } from "../../../dev/mock-print-trail"
import { PrintTrailClient } from "../../modules/printTrail/client/client"
import { accessRefusedNow, refusalWatch, AUTH_FAILED_STATE_KEY, CHANNEL_INACTIVE_STATE_KEY, createAuthTracker, type AuthFailedState } from "../auth-state"
import { PrintTrailApiError } from "../../modules/printTrail/client/errors"

const memoryState = () => {
  const map = new Map<string, unknown>()
  const writes: [string, unknown][] = []
  return {
    map,
    writes,
    async getState<T>(key: string): Promise<T | null> {
      return (map.get(key) as T | undefined) ?? null
    },
    async setState(key: string, value: unknown) {
      writes.push([key, value])
      map.set(key, value)
    },
  }
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error("timed out waiting for the state write")
}

let mock: MockPrintTrail
afterEach(async () => mock?.close())

const clientFor = (token: string, onStatus: (s: number, p: string, type?: string | null) => void) =>
  new PrintTrailClient({ baseUrl: mock.url, channelId: "acme-medusa1", apiToken: token, retryDelays: [], onStatus })

describe("auth_failed", () => {
  it("records auth_failed on a 401 and clears it on success", async () => {
    mock = await startMockPrintTrail({ token: "right-token", channelId: "acme-medusa1" })
    const state = memoryState()
    const tracker = createAuthTracker(state, null)

    await expect(clientFor("wrong-token", tracker).getToken()).rejects.toMatchObject({ status: 401 })
    await until(() => !!state.map.get(AUTH_FAILED_STATE_KEY))
    expect((state.map.get(AUTH_FAILED_STATE_KEY) as AuthFailedState).path).toBe("/token")

    // A second 401 writes nothing: the flag is already set.
    await expect(clientFor("wrong-token", tracker).getChannel()).rejects.toMatchObject({ status: 401 })
    await new Promise((r) => setTimeout(r, 30))
    expect(state.writes).toHaveLength(1)

    await clientFor("right-token", tracker).getToken()
    await until(() => state.map.get(AUTH_FAILED_STATE_KEY) === null)
    await clientFor("right-token", tracker).getToken()
    await new Promise((r) => setTimeout(r, 30))
    expect(state.writes).toHaveLength(2)
  })

  it("records channel_inactive on a typed 403 (API 1.2.0) and clears it on success", async () => {
    mock = await startMockPrintTrail({ token: "right-token", channelId: "acme-medusa1" })
    const state = memoryState()
    const tracker = createAuthTracker(state, null)
    mock.fail(/\/token$/, 403, { type: "https://docs.printtrail.com/channel-api/problems/channel-inactive", title: "Channel inactive", status: 403, detail: "This channel is inactive in Print Trail." })
    await expect(clientFor("right-token", tracker).getToken()).rejects.toMatchObject({ status: 403 })
    await until(() => !!state.map.get(CHANNEL_INACTIVE_STATE_KEY))
    expect(state.map.get(CHANNEL_INACTIVE_STATE_KEY)).toMatchObject({ path: "/token" })
    // Another 403 isn't an inactive channel.
    mock.fail(/\/token$/, 403, { type: "about:blank", title: "Forbidden", status: 403, detail: "Standard channel" })
    await expect(clientFor("right-token", tracker).getToken()).rejects.toMatchObject({ status: 403 })
    await clientFor("right-token", tracker).getToken()
    await until(() => state.map.get(CHANNEL_INACTIVE_STATE_KEY) === null)
    expect(state.writes.map(([k]) => k)).toEqual([CHANNEL_INACTIVE_STATE_KEY, CHANNEL_INACTIVE_STATE_KEY])
  })

  it("an inactive channel's 403 clears auth_failed: the token got past authentication", async () => {
    mock = await startMockPrintTrail({ token: "right-token", channelId: "acme-medusa1" })
    const state = memoryState()
    state.map.set(AUTH_FAILED_STATE_KEY, { at: "x", path: "/orders" })
    const tracker = createAuthTracker(state, null)
    mock.fail(/\/token$/, 403, { type: "https://docs.printtrail.com/channel-api/problems/channel-inactive", title: "Channel inactive", status: 403, detail: "This channel is inactive in Print Trail." })
    await expect(clientFor("right-token", tracker).getToken()).rejects.toMatchObject({ status: 403 })
    await until(() => state.map.get(AUTH_FAILED_STATE_KEY) === null && !!state.map.get(CHANNEL_INACTIVE_STATE_KEY))
  })

  it("two processes share the flag: a refusal after another process cleared it is recorded again", async () => {
    mock = await startMockPrintTrail({ token: "right-token", channelId: "acme-medusa1" })
    const state = memoryState()
    const web = createAuthTracker(state, null)
    const worker = createAuthTracker(state, null)
    // The worker hears a 401 and records it.
    await expect(clientFor("wrong-token", worker).getToken()).rejects.toMatchObject({ status: 401 })
    await until(() => !!state.map.get(AUTH_FAILED_STATE_KEY))
    // The web process's Test connection works: it clears the flag.
    await clientFor("right-token", web).getToken()
    await until(() => state.map.get(AUTH_FAILED_STATE_KEY) === null)
    // The worker's cache still says "set"; its next 401 must be recorded.
    await expect(clientFor("wrong-token", worker).getToken()).rejects.toMatchObject({ status: 401 })
    await until(() => !!state.map.get(AUTH_FAILED_STATE_KEY))
  })

  it("reads the stored flag once and writes nothing when it already matches", async () => {
    mock = await startMockPrintTrail({ token: "right-token", channelId: "acme-medusa1" })
    const state = memoryState()
    const tracker = createAuthTracker(state, null)
    await clientFor("right-token", tracker).getToken()
    await new Promise((r) => setTimeout(r, 30))
    expect(state.writes).toEqual([])
  })

  it("reads the flag again after a failed read", async () => {
    mock = await startMockPrintTrail({ token: "right-token", channelId: "acme-medusa1" })
    const warn = jest.fn()
    const state = memoryState()
    let failRead = true
    const flaky = {
      getState: async <T,>(key: string): Promise<T | null> => {
        if (failRead) {
          failRead = false
          throw new Error("db blip")
        }
        return state.getState<T>(key)
      },
      setState: state.setState.bind(state),
    }
    const tracker = createAuthTracker(flaky, { warn })
    await expect(clientFor("wrong-token", tracker).getToken()).rejects.toMatchObject({ status: 401 })
    await until(() => warn.mock.calls.length > 0)
    await expect(clientFor("wrong-token", tracker).getToken()).rejects.toMatchObject({ status: 401 })
    await until(() => !!state.map.get(AUTH_FAILED_STATE_KEY))
  })

  it("logs a failed write and never fails the request", async () => {
    mock = await startMockPrintTrail({ token: "right-token", channelId: "acme-medusa1" })
    const warn = jest.fn()
    const state = {
      getState: async () => null,
      setState: async () => {
        throw new Error("db down")
      },
    }
    const tracker = createAuthTracker(state, { warn })
    await expect(clientFor("wrong-token", tracker).getToken()).rejects.toMatchObject({ status: 401 })
    await until(() => warn.mock.calls.length > 0)
    expect(warn.mock.calls[0][0]).toContain("db down")
  })
})

describe("refusalWatch (stops a run once access is refused)", () => {
  it("is true once the process hears a refusal after the watch began", async () => {
    let count = 2
    const watch = await refusalWatch({ accessRefusalCount: async () => count })
    expect(await watch()).toBe(false)
    count = 3
    expect(await watch()).toBe(true)
  })
})

describe("accessRefusedNow (the sweep's and reconcile's gate)", () => {
  const err = (status: number, body: unknown) => new PrintTrailApiError("x", status, body, "GET", "/token", "d")
  const inactive = { type: "https://docs.printtrail.com/channel-api/problems/channel-inactive", status: 403, detail: "inactive" }

  it("doesn't probe while nothing is recorded", async () => {
    const probe = jest.fn()
    expect(await accessRefusedNow(memoryState(), probe)).toBeNull()
    expect(probe).not.toHaveBeenCalled()
  })

  it("probes once while a refusal is recorded, and goes ahead when it works", async () => {
    for (const key of [AUTH_FAILED_STATE_KEY, CHANNEL_INACTIVE_STATE_KEY]) {
      const state = memoryState()
      state.map.set(key, { at: "x", path: "/orders" })
      const probe = jest.fn(async () => ({}))
      expect(await accessRefusedNow(state, probe)).toBeNull()
      expect(probe).toHaveBeenCalledTimes(1)
    }
  })

  it("stops on a refusal, and on a 429 or another transient failure; goes ahead otherwise", async () => {
    const state = memoryState()
    state.map.set(AUTH_FAILED_STATE_KEY, { at: "x", path: "/orders" })
    expect(await accessRefusedNow(state, async () => Promise.reject(err(401, {})))).toBe("auth-failed")
    expect(await accessRefusedNow(state, async () => Promise.reject(err(403, inactive)))).toBe("channel-inactive")
    expect(await accessRefusedNow(state, async () => Promise.reject(err(503, null)))).toBe("unavailable")
    expect(await accessRefusedNow(state, async () => Promise.reject(err(429, null)))).toBe("unavailable")
    expect(await accessRefusedNow(state, async () => Promise.reject(err(0, null)))).toBe("unavailable")
    expect(await accessRefusedNow(state, async () => Promise.reject(err(404, {})))).toBeNull()
    expect(state.map.get(AUTH_FAILED_STATE_KEY)).toBeTruthy()
  })

  it("a probe that works clears both flags in the store, whatever this process's tracker cached", async () => {
    const state = memoryState()
    state.map.set(AUTH_FAILED_STATE_KEY, { at: "x", path: "/orders" })
    state.map.set(CHANNEL_INACTIVE_STATE_KEY, { at: "x", path: "/orders" })
    expect(await accessRefusedNow(state, async () => ({}))).toBeNull()
    expect(state.map.get(AUTH_FAILED_STATE_KEY)).toBeNull()
    expect(state.map.get(CHANNEL_INACTIVE_STATE_KEY)).toBeNull()
  })
})
