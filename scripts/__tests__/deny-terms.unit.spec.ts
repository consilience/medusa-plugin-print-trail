import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// scripts/deny-terms.mjs is an ES module, so each case runs in its own Node
// process. Git reads no global or system config there, so a maintainer's own
// printTrail.denyTermsFile can't leak in.
const root = path.resolve(__dirname, "../..")
const module_ = path.join(root, "scripts/deny-terms.mjs")
const gitEnv = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
const END = "# end of term list"

function run(code: string, env: Record<string, string> = {}, cwd = root) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...gitEnv, ...env },
  })
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() }
}

// Runs fn's body with the module's exports in scope and prints its result.
const call = (body: string) =>
  `import * as m from ${JSON.stringify(module_)}
   try { console.log(JSON.stringify(await (async () => { ${body} })())) }
   catch (e) { console.log(JSON.stringify({ error: e.message, denyTerms: e instanceof m.DenyTermsError })) }`

const result = (code: string, env?: Record<string, string>) => JSON.parse(run(call(code), env).out)

describe("the private term list", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "deny-terms-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("reports a private hit by its line number, never by its pattern", () => {
    const text = `# a comment\n\ncs:\\bSecretName\\b\nwidget/\n${END}\n`
    const hits = result(`
      const terms = m.parseDenyTerms(${JSON.stringify(text)}, "list")
      return [m.termsIn("a SecretName here", terms), m.termsIn("see widget/x and \\u00a7 2", terms)]`)
    expect(hits).toEqual([["private term 3"], ["/\\u00a7/", "private term 4"]])
    expect(JSON.stringify(hits)).not.toMatch(/SecretName|widget/)
  })

  it("names a line that doesn't compile by its number only", () => {
    const r = result(`return m.parseDenyTerms(${JSON.stringify(`ok\nsecret(unclosed\n${END}`)}, "PT_DENY_TERMS")`)
    expect(r).toEqual({ error: "PT_DENY_TERMS:2: not a regular expression", denyTerms: true })
  })

  it("refuses a list cut short: its last line that isn't blank must end it", () => {
    const cut = result(`return m.parseDenyTerms("one\\ntwo\\n", "PT_DENY_TERMS")`)
    expect(cut.denyTerms).toBe(true)
    expect(cut.error).toMatch(/doesn't end with "# end of term list", so it may be cut short/)
    expect(result(`return m.parseDenyTerms(${JSON.stringify(`${END}\nmore\n`)}, "x")`).error).toMatch(/cut short/)
    const crlf = result(`return m.parseDenyTerms(${JSON.stringify(`one\r\n${END}\r\n\r\n`)}, "x").length`)
    expect(crlf).toBe(1)
    expect(result(`return m.parseDenyTerms(${JSON.stringify(`# only comments\n${END}`)}, "x").length`)).toBe(0)
  })

  it("reads PT_DENY_TERMS, then PT_DENY_TERMS_FILE, then the git config key, relative to the root", () => {
    const repo = path.join(dir, "repo")
    expect(spawnSync("git", ["init", "-q", repo], { env: { ...process.env, ...gitEnv } }).status).toBe(0)
    writeFileSync(path.join(dir, "terms.txt"), `from-config\n${END}\n`)
    writeFileSync(path.join(dir, "named.txt"), `from-file\n${END}\n`)
    const load = (env: Record<string, string>) =>
      result(`const { source, terms } = m.loadDenyTerms({ env: ${JSON.stringify(env)}, root: ${JSON.stringify(repo)} })
              return { source, count: terms.length }`)

    expect(load({}).error).toMatch(/no private term list: .*PT_DENY_TERMS.*PT_DENY_TERMS_FILE.*printTrail\.denyTermsFile/)
    expect(spawnSync("git", ["config", "printTrail.denyTermsFile", "../terms.txt"], { cwd: repo, env: { ...process.env, ...gitEnv } }).status).toBe(0)
    expect(load({})).toEqual({ source: path.join(dir, "terms.txt"), count: 1 })
    expect(load({ PT_DENY_TERMS_FILE: path.join(dir, "named.txt") })).toEqual({ source: path.join(dir, "named.txt"), count: 1 })
    expect(load({ PT_DENY_TERMS: `a\nb\n${END}`, PT_DENY_TERMS_FILE: path.join(dir, "named.txt") })).toEqual({ source: "PT_DENY_TERMS", count: 2 })
    // A blank value falls through to the next source.
    expect(load({ PT_DENY_TERMS: " \n", PT_DENY_TERMS_FILE: " " })).toEqual({ source: path.join(dir, "terms.txt"), count: 1 })

    spawnSync("git", ["config", "printTrail.denyTermsFile", "missing.txt"], { cwd: repo, env: { ...process.env, ...gitEnv } })
    expect(load({}).error).toBe(`git config printTrail.denyTermsFile names ${path.join(repo, "missing.txt")}, which doesn't exist`)
  })

  it("stops check:repo with exit code 2, without a list or with one cut short", () => {
    const checkRepo = (env: Record<string, string>) =>
      spawnSync(process.execPath, [path.join(root, "scripts/check-repo.mjs")], {
        cwd: root,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", ...gitEnv, ...env },
      })
    const missing = checkRepo({ PT_DENY_TERMS_FILE: path.join(dir, "absent.txt") })
    expect(missing.status).toBe(2)
    expect(missing.stderr).toMatch(/absent\.txt, which doesn't exist/)
    const cut = checkRepo({ PT_DENY_TERMS: "zzalpha\nzzbeta\n" })
    expect(cut.status).toBe(2)
    expect(cut.stderr).toMatch(/may be cut short/)
    expect(cut.stderr).not.toMatch(/zzalpha|zzbeta/)
  })
})
