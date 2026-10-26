// Results, checks, polling and the human prompt.
import { createInterface } from "node:readline"

export type Status = "pass" | "fail" | "skipped" | "manual"
export type Result = { scenario: string; check: string; status: Status; detail: string; ms: number }

// A setup problem with the store or the mock (not a check's result).
export class ChecklistError extends Error {}

// Thrown inside a check to end it with that status. Fail ends the scenario.
export class Outcome extends Error {
  constructor(
    readonly status: Exclude<Status, "pass">,
    readonly detail: string
  ) {
    super(detail)
  }
}
export const fail = (detail: string): never => {
  throw new Outcome("fail", detail)
}
export const skip = (detail: string): never => {
  throw new Outcome("skipped", detail)
}
export const manual = (detail: string): never => {
  throw new Outcome("manual", detail)
}
export function expect(ok: unknown, detail: string): asserts ok {
  if (!ok) fail(detail)
}

// Output never stops the run: with the terminal gone (SIGHUP, a closed pipe)
// a write fails, and the cleanup must still happen.
export function quietOutput() {
  for (const stream of [process.stdout, process.stderr]) stream.on("error", () => undefined)
}

export function say(text: string, stream: NodeJS.WriteStream = process.stdout) {
  try {
    stream.write(text)
  } catch {
    // The terminal is gone.
  }
}

// stdin has ended (closed, or /dev/null): no one can answer.
export const inputEnded = () => process.stdin.readableEnded || process.stdin.destroyed

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Polls until fn returns something other than null/undefined/false.
export async function waitFor<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  opts: { timeoutMs: number; intervalMs?: number }
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs
  let lastError: unknown = null
  for (;;) {
    try {
      const value = await fn()
      if (value !== null && value !== undefined && value !== false) return value
      lastError = null
    } catch (e) {
      if (e instanceof Outcome) throw e
      lastError = e
    }
    if (Date.now() >= deadline) {
      const why = lastError ? ` (last error: ${(lastError as Error).message})` : ""
      return fail(`timed out after ${Math.round(opts.timeoutMs / 1000)}s waiting for ${what}${why}`)
    }
    await sleep(opts.intervalMs ?? 2000)
  }
}

export class Recorder {
  readonly results: Result[] = []
  constructor(private readonly redact: (s: string) => string) {}

  add(scenario: string, check: string, status: Status, detail: string, ms = 0) {
    const r = { scenario, check, status, detail: this.redact(detail), ms }
    this.results.push(r)
    const mark = { pass: "PASS", fail: "FAIL", skipped: "SKIP", manual: "MANUAL" }[status]
    say(`  ${mark.padEnd(6)} ${check}${r.detail ? ` — ${r.detail}` : ""}\n`)
  }
}

// Prompts. Ctrl-C inside a prompt reaches the process's SIGINT handler.
export async function ask(question: string): Promise<string> {
  if (inputEnded()) {
    say(`${question}(no input: skipped)\n`)
    return ""
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  rl.on("SIGINT", () => {
    rl.close()
    process.emit("SIGINT")
  })
  try {
    // End of input (stdin closed or not a terminal) answers "".
    return await new Promise<string>((resolve) => {
      rl.once("close", () => resolve(""))
      process.stdin.once("end", () => resolve(""))
      rl.question(question, resolve)
    })
  } finally {
    rl.close()
  }
}

// Shows instructions and polls `until` while the tester works. They can type
// "s" and Enter to give up on the step, which records it as manual.
export async function humanStep<T>(input: {
  interactive: boolean
  title: string
  steps: string[]
  until: () => Promise<T | null | undefined | false>
  timeoutMs: number
  intervalMs?: number
}): Promise<T> {
  if (!input.interactive) return manual(`needs a person: ${input.title} (run without --non-interactive)`)
  if (inputEnded()) return manual(`no input to read (stdin has ended): ${input.title}`)
  say(`\n  >>> ${input.title}\n`)
  for (const s of input.steps) say(`      - ${s}\n`)
  say(`      Waiting up to ${Math.round(input.timeoutMs / 60000)} min. Type s + Enter to skip this step.\n`)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  rl.on("SIGINT", () => {
    rl.close()
    process.emit("SIGINT")
  })
  let skipped = false
  rl.on("line", (line) => {
    if (line.trim().toLowerCase() === "s") skipped = true
  })
  // No input to read (stdin closed): nobody can do the step.
  let closedByUs = false
  rl.on("close", () => {
    if (!closedByUs) skipped = true
  })
  process.stdin.once("end", () => {
    skipped = true
  })
  try {
    return await waitFor(
      input.title,
      async () => {
        if (skipped) manual(`skipped by the tester: ${input.title}`)
        return input.until()
      },
      { timeoutMs: input.timeoutMs, intervalMs: input.intervalMs ?? 3000 }
    )
  } finally {
    closedByUs = true
    rl.close()
  }
}

// A yes/no a person answers (an email arrived, say).
export async function humanConfirm(interactive: boolean, question: string): Promise<string> {
  if (!interactive) return manual(`needs a person: ${question}`)
  const answer = (await ask(`\n  >>> ${question} [y/n/s] `)).trim().toLowerCase()
  if (answer.startsWith("y")) return "confirmed by the tester"
  if (answer.startsWith("n")) return fail("the tester answered no")
  return manual("skipped by the tester")
}

export function table(results: Result[]): string {
  const rows = results.map((r) => [r.status.toUpperCase(), r.scenario, r.check, r.detail.length > 90 ? `${r.detail.slice(0, 87)}...` : r.detail])
  const head = ["STATUS", "SCENARIO", "CHECK", "DETAIL"]
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const line = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd()
  return [line(head), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n")
}

export function counts(results: Result[]): Record<Status, number> {
  const c: Record<Status, number> = { pass: 0, fail: 0, skipped: 0, manual: 0 }
  for (const r of results) c[r.status]++
  return c
}
