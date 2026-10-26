// Writes after the reader of stdout and stderr has gone, then records that it
// got to the end (as the cleanup must).
import { writeFileSync } from "node:fs"
import { quietOutput, Recorder, say } from "../../lib/runner"

quietOutput()
const recorder = new Recorder((s) => s)
setTimeout(() => {
  for (let i = 0; i < 2000; i++) {
    say(`line ${i} ${"x".repeat(200)}\n`)
    say(`err ${i}\n`, process.stderr)
    recorder.add("s", `check ${i}`, "pass", "x".repeat(200))
  }
  setTimeout(() => writeFileSync(process.argv[2], "done"), 200)
}, 300)
