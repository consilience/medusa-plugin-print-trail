import { JOB_SCHEDULES, scheduleFor, schedulesInForce } from "../schedules"

describe("job schedules", () => {
  it("reads each schedule from the environment with its default", () => {
    expect(schedulesInForce({})).toEqual([
      { job: "print-trail-sweep", variable: "PRINT_TRAIL_SWEEP_SCHEDULE", schedule: "*/5 * * * *", isDefault: true },
      { job: "print-trail-reconcile", variable: "PRINT_TRAIL_RECONCILE_SCHEDULE", schedule: "0 */6 * * *", isDefault: true },
      { job: "print-trail-stock-sync", variable: "PRINT_TRAIL_STOCK_SCHEDULE", schedule: "0 3 * * *", isDefault: true },
    ])
    const env = { PRINT_TRAIL_SWEEP_SCHEDULE: "*/2 * * * *", PRINT_TRAIL_STOCK_SCHEDULE: "   " }
    expect(scheduleFor("sweep", env)).toBe("*/2 * * * *")
    expect(scheduleFor("stock", env)).toBe(JOB_SCHEDULES.stock.fallback)
    const views = schedulesInForce(env)
    expect(views[0]).toEqual({ job: "print-trail-sweep", variable: "PRINT_TRAIL_SWEEP_SCHEDULE", schedule: "*/2 * * * *", isDefault: false })
    expect(views[2].isDefault).toBe(true)
  })
})
