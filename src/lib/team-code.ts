import type { PrintTrailClient } from "../modules/printTrail/client/client"

export const TEAM_CODE_STATE_KEY = "team_code"

export type TeamCodeState = { teamCode: string; channelCode: string; channelId: string; fetchedAt: string }

// PrintTrailModuleService satisfies this.
export type StateStore = {
  getState<T>(key: string): Promise<T | null>
  setState(key: string, value: unknown): Promise<void>
}

// The team code for links into the Print Trail app, from GET /token. Stored in
// print_trail_state and fetched only when missing or on refresh ("Test
// connection"). Never throws: on an API error it returns what's stored, or null.
export async function ensureTeamCode(
  state: StateStore,
  client: Pick<PrintTrailClient, "getToken">,
  opts: { refresh?: boolean; now?: () => Date } = {}
): Promise<string | null> {
  const stored = await state.getState<TeamCodeState>(TEAM_CODE_STATE_KEY)
  if (stored?.teamCode && !opts.refresh) {
    return stored.teamCode
  }
  try {
    const token = await client.getToken()
    if (!token?.teamCode) {
      return stored?.teamCode ?? null
    }
    const value: TeamCodeState = {
      teamCode: token.teamCode,
      channelCode: token.channelCode,
      channelId: token.channelId,
      fetchedAt: (opts.now ? opts.now() : new Date()).toISOString(),
    }
    await state.setState(TEAM_CODE_STATE_KEY, value)
    return value.teamCode
  } catch {
    return stored?.teamCode ?? null
  }
}
