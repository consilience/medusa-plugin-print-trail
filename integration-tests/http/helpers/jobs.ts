// Scheduled jobs don't fire in a test, so tests run them with the app container.
import path from "node:path"
import type { MedusaContainer } from "@medusajs/framework/types"
import { printTrail } from "./rows"
import { waitFor } from "./wait"

const root = path.resolve(__dirname, "../../..")

export type JobName = "print-trail-sweep" | "print-trail-reconcile" | "print-trail-stock-sync"

export async function runJob(
  container: MedusaContainer,
  name: JobName,
  waitWorkflowExecutions?: () => Promise<void>
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const job = require(path.join(root, ".medusa/server/src/jobs", `${name}.js`))
  await job.default(container)
  await waitWorkflowExecutions?.()
}

type StockRun = { trigger: string; startedAt: string; completedAt: string }

// The stock job, run until it isn't deferred. A stock refresh the last
// test's events started (after a dispatch, say) can still hold the
// in-memory print-trail:stock lock when this test begins: the runner's
// afterEach waits only for workflows already running, and the next test's
// job was then deferred with nothing in the test noticing.
export function stockJob(container: MedusaContainer, waitWorkflowExecutions?: () => Promise<void>): Promise<StockRun> {
  return waitFor(async () => {
    const since = new Date().toISOString()
    await runJob(container, "print-trail-stock-sync", waitWorkflowExecutions)
    const run: StockRun | undefined = await printTrail(container).getState("stock_last_run")
    return run?.trigger === "schedule" && run.startedAt >= since ? run : undefined
  }, { what: "a stock job that wasn't deferred" })
}

// The stock-level-updated webhook's own sync, completed after `before` (the
// last run's completedAt). Deferred behind another run's lock, the sweep
// runs it.
export function webhookStockRun(
  container: MedusaContainer,
  before: string | undefined,
  waitWorkflowExecutions?: () => Promise<void>
): Promise<StockRun> {
  return waitFor(async () => {
    const service = printTrail(container)
    const run: StockRun | undefined = await service.getState("stock_last_run")
    if ((run?.trigger === "webhook" || run?.trigger === "pending") && run.completedAt !== before) return run
    if ((await service.getState("stock_sync_pending"))?.requestedAt) {
      await runJob(container, "print-trail-sweep", waitWorkflowExecutions)
    }
    return undefined
  }, { what: "the webhook's stock sync" })
}
