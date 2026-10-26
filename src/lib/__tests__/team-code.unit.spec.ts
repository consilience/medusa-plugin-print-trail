import { startMockPrintTrail, type MockPrintTrail } from "../../../dev/mock-print-trail"
import { PrintTrailClient } from "../../modules/printTrail/client/client"
import { ensureTeamCode, TEAM_CODE_STATE_KEY, type StateStore } from "../team-code"

const NOW = new Date("2026-10-19T12:00:00Z")

class MemoryState implements StateStore {
  values = new Map<string, unknown>()
  async getState<T>(key: string) {
    return (this.values.get(key) as T | undefined) ?? null
  }
  async setState(key: string, value: unknown) {
    this.values.set(key, value)
  }
}

let mock: MockPrintTrail
let client: PrintTrailClient
let state: MemoryState

beforeEach(async () => {
  mock = await startMockPrintTrail({ token: "t", channelId: "acme-medusa1" })
  client = new PrintTrailClient({ baseUrl: mock.url, channelId: "acme-medusa1", apiToken: "t", retryDelays: [0] })
  state = new MemoryState()
})

afterEach(() => mock.close())

const tokenCalls = () => mock.state.requests.filter((r) => r.path.endsWith("/token")).length

describe("ensureTeamCode", () => {
  it("fetches the team code once and stores it", async () => {
    expect(await ensureTeamCode(state, client, { now: () => NOW })).toBe("acme")
    expect(state.values.get(TEAM_CODE_STATE_KEY)).toEqual({
      teamCode: "acme",
      channelCode: "medusa1",
      channelId: "acme-medusa1",
      fetchedAt: NOW.toISOString(),
    })
    expect(await ensureTeamCode(state, client)).toBe("acme")
    expect(tokenCalls()).toBe(1)
  })

  it("fetches again on refresh", async () => {
    await ensureTeamCode(state, client)
    await ensureTeamCode(state, client, { refresh: true })
    expect(tokenCalls()).toBe(2)
  })

  it("never throws: returns the stored code, or null", async () => {
    mock.fail(/\/token$/, 500, undefined, 9)
    expect(await ensureTeamCode(state, client)).toBeNull()
    await state.setState(TEAM_CODE_STATE_KEY, { teamCode: "old", channelCode: "c", channelId: "x", fetchedAt: "" })
    expect(await ensureTeamCode(state, client, { refresh: true })).toBe("old")
  })
})
