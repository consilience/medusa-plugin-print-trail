// Job schedules come from environment variables read when the job file loads
// (a job's config is a static export, evaluated before plugin options exist).
// Shared by the jobs and the settings page, so both show the same values.
export const JOB_SCHEDULES = {
  sweep: { job: "print-trail-sweep", variable: "PRINT_TRAIL_SWEEP_SCHEDULE", fallback: "*/5 * * * *" },
  reconcile: { job: "print-trail-reconcile", variable: "PRINT_TRAIL_RECONCILE_SCHEDULE", fallback: "0 */6 * * *" },
  stock: { job: "print-trail-stock-sync", variable: "PRINT_TRAIL_STOCK_SCHEDULE", fallback: "0 3 * * *" },
} as const

export type ScheduleView = { job: string; variable: string; schedule: string; isDefault: boolean }

const fromEnv = (k: keyof typeof JOB_SCHEDULES, env: NodeJS.ProcessEnv) => env[JOB_SCHEDULES[k].variable]?.trim() || null

export function scheduleFor(k: keyof typeof JOB_SCHEDULES, env: NodeJS.ProcessEnv = process.env): string {
  return fromEnv(k, env) ?? JOB_SCHEDULES[k].fallback
}

export function schedulesInForce(env: NodeJS.ProcessEnv = process.env): ScheduleView[] {
  return (Object.keys(JOB_SCHEDULES) as (keyof typeof JOB_SCHEDULES)[]).map((k) => {
    const set = fromEnv(k, env)
    return { job: JOB_SCHEDULES[k].job, variable: JOB_SCHEDULES[k].variable, schedule: set ?? JOB_SCHEDULES[k].fallback, isDefault: !set }
  })
}
