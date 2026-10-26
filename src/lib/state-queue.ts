// Creates each key, one at a time. A key another writer created meanwhile is
// fine; any other failure is rethrown, so no queued id is dropped silently.
export async function createEachUnlessExists(
  keys: string[],
  create: (key: string) => Promise<unknown>,
  exists: (key: string) => Promise<boolean>
): Promise<void> {
  for (const key of keys) {
    try {
      await create(key)
    } catch (e) {
      if (!(await exists(key))) throw e
    }
  }
}
