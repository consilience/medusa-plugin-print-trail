// Two prompts and a person's step with stdin at end of input: each must
// answer at once (empty / manual), never hang.
import { ask, humanStep, Outcome } from "../../lib/runner"

async function main() {
  const a = await ask("first? ")
  const b = await ask("second? ")
  let step = "passed"
  try {
    await humanStep({ interactive: true, title: "a step", steps: [], until: async () => false, timeoutMs: 60_000 })
  } catch (e) {
    step = e instanceof Outcome ? e.status : "error"
  }
  process.stdout.write(`\nRESULT ${JSON.stringify({ a, b, step })}\n`)
}
main()
