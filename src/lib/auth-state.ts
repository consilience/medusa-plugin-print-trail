import { ACCESS_REFUSED, PrintTrailApiError, PROBLEM_TYPES, type AccessRefusal } from "../modules/printTrail/client/errors"
import type { StateStore } from "./team-code"

// Set by any 401 from Print Trail, cleared by any 2xx, so the
// admin can say "Reconnect Print Trail". Since API 1.2.0 a 401 also means an
// unknown channel ID.
export const AUTH_FAILED_STATE_KEY = "auth_failed"
export type AuthFailedState = { at: string; path: string }

// API 1.2.0: set by a 403 of type channel-inactive, cleared by any 2xx (an
// inactive channel is refused on every endpoint, so any success means it is
// active again). While set, the admin says the channel is inactive.
export const CHANNEL_INACTIVE_STATE_KEY = "channel_inactive"
export type ChannelInactiveState = AuthFailedState

type Logger = { warn(message: string): void }

// One stored flag. Read once; a write happens only on a change, and is fire
// and forget: a failed write is logged and never fails the request that
// triggered it.
function flagTracker(state: StateStore, key: string, logger: Logger | null, now: () => Date) {
  let known: Promise<boolean> | undefined

  const track = async (set: boolean, path: string): Promise<void> => {
    // A refusal always reads the store again: another process (Test
    // connection, the sweep's probe) may have cleared the flag this one
    // cached as set. Refusals are rare; successes use the cache.
    if (set) known = undefined
    known ??= state.getState<AuthFailedState>(key).then(
      (v) => !!v,
      (e) => {
        // Never cache a failed read: the next request reads again.
        known = undefined
        throw e
      }
    )
    const current = known
    if ((await current) === set || known !== current) return
    // Claim the change before writing, so concurrent requests write once.
    known = Promise.resolve(set)
    try {
      await state.setState(key, set ? ({ at: now().toISOString(), path } satisfies AuthFailedState) : null)
    } catch (e) {
      // Read it again next time rather than trusting an unwritten change.
      known = undefined
      throw e
    }
  }

  return (set: boolean, path: string): void => {
    track(set, path).catch((e) => logger?.warn(`Print Trail: couldn't record ${key}: ${(e as Error)?.message ?? e}`))
  }
}

// The sweep's and reconcile's gate. While auth_failed or channel_inactive is
// recorded, one probe (GET /token) goes first, so a run doesn't spend a
// refused request on every due row: Print Trail limits failed requests per
// IP address (API 1.2.0: 60 a minute, then every request gets 429). A probe
// that works clears the flags (through the client's tracker) and the run
// goes ahead; one refused again stops it, and so does one that fails
// transiently ("unavailable": a 429, Print Trail unreachable), so the run's
// due work doesn't fail row by row. A probe that works clears both flags in
// the store itself: this process's tracker may have cached them as clear
// while another process recorded them.
export async function accessRefusedNow(
  state: Pick<StateStore, "getState" | "setState">,
  probe: () => Promise<unknown>
): Promise<AccessRefusal | "unavailable" | null> {
  const [authFailed, inactive] = await Promise.all([
    state.getState<AuthFailedState>(AUTH_FAILED_STATE_KEY),
    state.getState<ChannelInactiveState>(CHANNEL_INACTIVE_STATE_KEY),
  ])
  if (!authFailed && !inactive) return null
  try {
    await probe()
  } catch (e) {
    if (!(e instanceof PrintTrailApiError)) return null
    return e.accessRefusal ?? (e.isTransient ? "unavailable" : null)
  }
  if (authFailed) await state.setState(AUTH_FAILED_STATE_KEY, null)
  if (inactive) await state.setState(CHANNEL_INACTIVE_STATE_KEY, null)
  return null
}

export const ACCESS_SKIPPED: Record<AccessRefusal | "unavailable", string> = {
  ...ACCESS_REFUSED,
  unavailable: "Print Trail access was refused earlier, and the check before this run couldn't reach Print Trail",
}

// Whether this process has heard a refusal (a 401, or channel-inactive)
// since the watch began: a job checks it after each row, so the first run
// after access is lost makes one refused request, not one per due row.
export async function refusalWatch(service: { accessRefusalCount(): Promise<number> }): Promise<() => Promise<boolean>> {
  const start = await service.accessRefusalCount()
  return async () => (await service.accessRefusalCount()) > start
}

// The client's onStatus hook: auth_failed and channel_inactive.
export function createAuthTracker(state: StateStore, logger: Logger | null, now: () => Date = () => new Date()) {
  const authFailed = flagTracker(state, AUTH_FAILED_STATE_KEY, logger, now)
  const channelInactive = flagTracker(state, CHANNEL_INACTIVE_STATE_KEY, logger, now)

  return (status: number, path: string, problemType?: string | null): void => {
    if (status >= 200 && status < 300) {
      authFailed(false, path)
      channelInactive(false, path)
    } else if (status === 401) {
      authFailed(true, path)
    } else if (status === 403 && problemType === PROBLEM_TYPES.channelInactive) {
      // Checked after authentication: the token and channel ID are good.
      authFailed(false, path)
      channelInactive(true, path)
    }
  }
}
