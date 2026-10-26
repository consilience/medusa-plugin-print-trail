import type { StateStore } from "./team-code"

// The Print Trail API version the store last heard (Print-Trail-Api-Version on
// every response: 1.1.0 for the 2026-10-19 batch, 1.2.0 for the security
// release, 1.3.0 for pre-order products). Shown on the settings page only:
// behaviour is chosen by field presence, never by this number.
export const API_VERSION_STATE_KEY = "api_version"
export type ApiVersionState = { version: string; seenAt: string }

type Logger = { warn(message: string): void }

// The client's onApiVersion hook. The stored value is read once; a write
// happens only when the version changes, fire and forget, so a failed write
// never fails the request that carried the header.
export function createApiVersionTracker(state: StateStore, logger: Logger | null, now: () => Date = () => new Date()) {
  let known: Promise<string | null> | undefined

  const track = async (version: string): Promise<void> => {
    known ??= state.getState<ApiVersionState>(API_VERSION_STATE_KEY).then(
      (v) => (typeof v?.version === "string" ? v.version : null),
      (e) => {
        known = undefined
        throw e
      }
    )
    const current = known
    if ((await current) === version || known !== current) return
    // Claim the change before writing, so concurrent responses write once.
    known = Promise.resolve(version)
    try {
      await state.setState(API_VERSION_STATE_KEY, { version, seenAt: now().toISOString() } satisfies ApiVersionState)
    } catch (e) {
      known = undefined
      throw e
    }
  }

  return (version: string, _path: string): void => {
    track(version).catch((e) => logger?.warn(`Print Trail: couldn't record the Print Trail API version: ${(e as Error)?.message ?? e}`))
  }
}

export async function readApiVersion(state: Pick<StateStore, "getState">): Promise<{ version: string; seen_at: string } | null> {
  const v = await state.getState<ApiVersionState>(API_VERSION_STATE_KEY)
  return typeof v?.version === "string" && v.version
    ? { version: v.version, seen_at: typeof v.seenAt === "string" ? v.seenAt : "" }
    : null
}
