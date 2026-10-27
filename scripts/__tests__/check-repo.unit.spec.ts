import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// scripts/check-repo.mjs is an ES module, so each case runs it in its own Node
// process, against a temporary git repository. Git reads no global or system
// config there, so a maintainer's own settings can't leak in. Nothing is
// committed unless a case compares with `git archive` of a commit: the check
// reads the index.
const root = path.resolve(__dirname, "../..")
const script = path.join(root, "scripts/check-repo.mjs")
const env = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
}
const terms = "zebrafish\n# end of term list\n"
const ignoreSecret = "/secret/ export-ignore\n/.gitattributes export-ignore\n"
const sorted = (paths: string[]) => [...paths].sort()

describe("check:repo checks what git archive exports", () => {
  let repo: string
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", env })
    if (r.status !== 0) throw new Error(r.stderr)
    return r.stdout
  }
  const write = (files: Record<string, string>) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
      writeFileSync(path.join(repo, file), text)
    }
  }
  const stage = (files: Record<string, string>) => {
    write(files)
    git("add", "-A")
  }
  // Each file's text is its path, so a fixture is a list of paths.
  const stagePaths = (paths: string[], extra: Record<string, string> = {}) =>
    stage({ ...Object.fromEntries(paths.map((p) => [p, `${p}\n`])), ...extra })

  // The paths of the index entries exportedEntries keeps.
  const exported = () => {
    const code = `import { exportedEntries, indexEntries } from ${JSON.stringify(script)}
      const entries = indexEntries(${JSON.stringify(repo)})
      console.log(JSON.stringify({ entries, kept: exportedEntries(${JSON.stringify(repo)}, entries) }))`
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: repo, encoding: "utf8", env })
    if (r.status !== 0) throw new Error(r.stderr)
    const { entries, kept }: { entries: unknown[]; kept: { path: string }[] } = JSON.parse(r.stdout)
    for (const entry of kept) expect(entries).toContainEqual(entry)
    return kept.map((e) => e.path)
  }

  // The files `git archive HEAD` writes, as the system's tar lists them.
  const archivedFiles = () => {
    const tar = path.join(repo, ".git", "archive.tar")
    git("archive", "--format=tar", "-o", tar, "HEAD")
    const r = spawnSync("tar", ["-tf", tar], { encoding: "utf8" })
    if (r.status !== 0) throw new Error(r.stderr)
    return r.stdout.split("\n").filter((p) => p && !p.endsWith("/"))
  }

  const checkRepo = (cwd = repo) =>
    spawnSync(process.execPath, [script], { cwd, encoding: "utf8", env: { ...env, PT_DENY_TERMS: terms } })

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "check-repo-"))
    git("init", "-q")
  })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it("exportedEntries drops paths marked export-ignore", () => {
    stagePaths(["secret/a.md", "secret/deep/c.md", "src/b.ts"], { ".gitattributes": ignoreSecret })
    expect(exported()).toEqual(["src/b.ts"])
  })

  it("exportedEntries keeps everything without a .gitattributes", () => {
    stagePaths(["secret/a.md", "src/b.ts"])
    expect(exported()).toEqual(["secret/a.md", "src/b.ts"])
  })

  it("exportedEntries reads the attributes from the index, not the working tree", () => {
    stagePaths(["secret/a.md", "src/b.ts"], { ".gitattributes": ignoreSecret })
    write({ ".gitattributes": `${ignoreSecret}/src/ export-ignore\n` })
    expect(exported()).toEqual(["src/b.ts"])
  })

  it("exportedEntries keeps a file whose export-ignore is given any value, as git archive does", () => {
    // git check-attr prints "set" both for export-ignore and for the value
    // "set", but only the first makes git archive skip a file.
    const valued = ["README.md", "unset.md", "true.md", "one.md", "empty.md"]
    stagePaths(valued, {
      ".gitattributes":
        "README.md export-ignore=set\nunset.md export-ignore=unset\ntrue.md export-ignore=true\n" +
        "one.md export-ignore=1\nempty.md export-ignore=\n/.gitattributes export-ignore\n",
    })
    expect(git("check-attr", "--cached", "export-ignore", "README.md")).toBe("README.md: export-ignore: set\n")
    expect(exported()).toEqual(sorted(valued))

    git("commit", "-qm", "fixture")
    expect(sorted(archivedFiles())).toEqual(sorted(valued))
  })

  it("check:repo scans a README whose export-ignore is the value set", () => {
    stage({ ".gitattributes": "README.md export-ignore=set\n", "README.md": "a zebrafish\n" })
    const failed = checkRepo()
    expect(failed.status).toBe(1)
    expect(failed.stderr).toMatch(/README\.md:1: private term 1/)
  })

  it("exportedEntries matches git archive on nested patterns, macros and nested .gitattributes", () => {
    stagePaths(
      [
        "a/keep.md",
        "a/b.md",
        "src/tmp/x.ts",
        "src/deep/tmp/y.ts",
        "tmp/z.ts",
        "src/ok.ts",
        "docs/one/two/draft.md",
        "docs/draft.md",
        "docs/final.md",
        "build.log",
        "src/build.log",
        "m/z.md",
        "x/y/z.md",
        "q/x/y/z.md",
        "set.md",
        "n/inner/a.md",
        "n/deep/inner/b.md",
        "n/a.secret",
        "n/shown.secret",
        "n/ok.md",
      ],
      {
        ".gitattributes": [
          "[attr]private export-ignore",
          "/a/ export-ignore",
          "a/keep.md -export-ignore",
          "**/tmp/ export-ignore",
          "docs/**/draft.md export-ignore",
          "*.log export-ignore",
          "/m/ private",
          "x/y/ export-ignore",
          "set.md export-ignore=set",
          "/.gitattributes export-ignore",
          "",
        ].join("\n"),
        "n/.gitattributes": "inner/ export-ignore\n*.secret export-ignore\nshown.secret -export-ignore\n",
      }
    )
    const kept = exported()
    expect(sorted(kept)).toEqual([
      "docs/final.md",
      "n/.gitattributes",
      "n/ok.md",
      "n/shown.secret",
      "q/x/y/z.md",
      "set.md",
      "src/ok.ts",
    ])

    git("commit", "-qm", "fixture")
    expect(sorted(kept)).toEqual(sorted(archivedFiles()))
  })

  it("exportedEntries reads long paths from the archive (the ustar prefix, and a pax header)", () => {
    const split = `${"d".repeat(60)}/${"e".repeat(60)}/f.md`
    const pax = `g/${"h".repeat(120)}.md`
    const longer = `${"i".repeat(150)}/${"j".repeat(150)}/k.md`
    const accented = "café/naïve.md"
    stagePaths([split, pax, longer, accented, "short.md"])
    expect(sorted(exported())).toEqual(sorted([split, pax, longer, accented, "short.md"]))
  })

  it("exportedEntries keeps a submodule unless it is export-ignored", () => {
    stagePaths(["src/b.ts"], { ".gitattributes": "/hidden export-ignore\n/.gitattributes export-ignore\n" })
    // Staged without a working tree (`git add -A` would drop them).
    git("update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},sub`)
    git("update-index", "--add", "--cacheinfo", `160000,${"2".repeat(40)},hidden`)
    expect(exported()).toEqual(["src/b.ts", "sub"])
  })

  it("exportedEntries leaves the index and the repository's objects as they were", () => {
    stagePaths(["src/b.ts", "secret/a.md"], { ".gitattributes": ignoreSecret })
    const index = readFileSync(path.join(repo, ".git", "index"))
    const objects = git("count-objects", "-v")
    expect(exported()).toEqual(["src/b.ts"])
    expect(readFileSync(path.join(repo, ".git", "index")).equals(index)).toBe(true)
    expect(git("count-objects", "-v")).toBe(objects)
  })

  it("check:repo fails, exit 2, when the index has unmerged entries", () => {
    stagePaths(["src/b.ts"])
    const oid = git("hash-object", "-w", "src/b.ts").trim()
    const unmerged = spawnSync("git", ["update-index", "--index-info"], {
      cwd: repo,
      env,
      input: `100644 ${oid} 1\tsrc/c.ts\n100644 ${oid} 2\tsrc/c.ts\n`,
    })
    expect(unmerged.status).toBe(0)
    const failed = checkRepo()
    expect(failed.status).toBe(2)
    expect(failed.stderr).toMatch(/the index can't be written as a tree/)
  })

  it("check:repo passes a term in an export-ignored file and fails it elsewhere", () => {
    stage({ ".gitattributes": ignoreSecret, "secret/a.md": "a zebrafish\n", "src/b.ts": "export {}\n" })
    const passed = checkRepo()
    expect(passed.stderr).toBe("")
    expect(passed.status).toBe(0)
    expect(passed.stdout).toMatch(/repository ok: 1 exported file/)

    stage({ "src/b.ts": "// a zebrafish\nexport {}\n" })
    const failed = checkRepo()
    expect(failed.status).toBe(1)
    expect(failed.stderr).toMatch(/src\/b\.ts:1: private term 1/)
    expect(failed.stderr).not.toMatch(/secret/)
    // Run from a subdirectory, it still checks the whole repository.
    expect(checkRepo(path.join(repo, "src")).status).toBe(1)
  })

  it("check:repo passes a term in an export-ignored file's name and fails it elsewhere", () => {
    stage({ ".gitattributes": ignoreSecret, "secret/zebrafish.md": "a note\n", "src/b.ts": "export {}\n" })
    expect(checkRepo().status).toBe(0)

    stage({ "src/zebrafish.ts": "export {}\n" })
    const failed = checkRepo()
    expect(failed.status).toBe(1)
    expect(failed.stderr).toMatch(/src\/zebrafish\.ts: in the file name: private term 1/)
    expect(failed.stderr).not.toMatch(/secret/)
  })
})
