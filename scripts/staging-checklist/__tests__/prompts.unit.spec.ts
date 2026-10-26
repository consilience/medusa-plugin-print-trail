import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(__dirname, "../../..")
const jiti = join(root, "node_modules/.bin/jiti")
const fixture = (name: string) => join(__dirname, "fixtures", name)

describe("checklist prompts and output", () => {
  it("answers every prompt at once when stdin has ended", () => {
    const res = spawnSync(jiti, [fixture("two-prompts.ts")], { cwd: root, input: "", encoding: "utf8", timeout: 30_000 })
    const line = (res.stdout ?? "").split("\n").find((l) => l.startsWith("RESULT "))
    expect(line).toBeDefined()
    expect(JSON.parse(line!.slice(7))).toEqual({ a: "", b: "", step: "manual" })
  }, 40_000)

  it("keeps going when the terminal's reader has gone", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "ck-out-")), "done")
    const child = spawn(jiti, [fixture("dead-output.ts"), marker], { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
    child.stdout.destroy()
    child.stderr.destroy()
    const code = await new Promise<number | null>((r) => child.on("exit", r))
    expect(code).toBe(0)
    expect(existsSync(marker) && readFileSync(marker, "utf8")).toBe("done")
  }, 40_000)
})
