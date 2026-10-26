// Polls until fn returns something truthy, or throws "timed out waiting for <what>".
export async function waitFor<T>(
  fn: () => Promise<T | undefined | false | null>,
  opts: { timeoutMs?: number; intervalMs?: number; what?: string } = {}
): Promise<T> {
  const { timeoutMs = 10_000, intervalMs = 100, what = "a condition" } = opts
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  for (;;) {
    try {
      const value = await fn()
      if (value) return value
    } catch (e) {
      lastError = e
    }
    if (Date.now() > deadline) {
      // eslint-disable-next-line @medusajs/use-medusa-error-not-generic-error
      throw new Error(
        `timed out waiting for ${what}` + (lastError ? ` (last error: ${(lastError as Error).message})` : "")
      )
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
