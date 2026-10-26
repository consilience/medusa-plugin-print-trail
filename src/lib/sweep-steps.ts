// The sweep's steps in order. Each runs even when an earlier one threw, so a
// failing retry pass never stops the stock and SKU-check queues.
export type SweepSteps = {
  dueRetries(): Promise<void>
  missedOrders(): Promise<void>
  pendingStock(): Promise<void>
  skuChecks(): Promise<void>
  // With the stock sync off: the one-off scan of variant metadata.
  legacyMetadata(): Promise<void>
}

export async function runSweepSteps(steps: SweepSteps, logger: { error(msg: string): void }): Promise<void> {
  const order: (keyof SweepSteps)[] = ["dueRetries", "missedOrders", "pendingStock", "skuChecks", "legacyMetadata"]
  for (const name of order) {
    try {
      await steps[name]()
    } catch (e) {
      logger.error(`Print Trail sweep: ${name} failed: ${(e as Error)?.message ?? e}`)
    }
  }
}
