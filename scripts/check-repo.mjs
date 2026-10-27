#!/usr/bin/env node
// Checks what `git archive` would export from the repository, as staged, for
// internal references, as the package check does for what ships: each file's
// name, and the text of every text file (text is decided by content, not
// extension; binary files are listed, not scanned). It reads the index (`git
// ls-files --stage`), so what is checked is what a commit of the index would
// export, whatever the working tree holds. `git archive` itself decides which
// files that is: the index is written as a tree and the archive of that tree
// is listed, so a file is skipped exactly when `git archive` skips it (the
// attributes are the staged .gitattributes files, with $GIT_DIR/info/attributes
// and core.attributesFile, as for any archive). The tree is written from a
// copy of the index into a temporary object directory, so neither the index
// nor the repository's objects change; an index with unmerged entries can't
// be written, and fails the check. The repository is the one holding the
// current directory. The terms are scripts/deny-terms.mjs's generic patterns
// and the maintainers' private term list, without which the check fails; its
// allowed text is removed before a line is scanned.
import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { pathToFileURL } from "node:url"
import { denyTermsOrExit, internalReferences, isText, termsIn } from "./deny-terms.mjs"

const git = (root, args, input, env = process.env) =>
  execFileSync("git", args, { cwd: root, input, env, maxBuffer: 256 * 1024 * 1024 })

// The root of the repository holding the current directory, or exit 2.
function repositoryRoot(check) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    console.error(`${check} failed: the current directory isn't in a git repository`)
    process.exit(2)
  }
}

// The index's entries, as { path, mode, oid }.
export function indexEntries(root) {
  return git(root, ["ls-files", "--stage", "-z"])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf("\t")
      const [mode, oid] = entry.slice(0, tab).split(" ")
      return { path: entry.slice(tab + 1), mode, oid }
    })
}

// The paths in a tar archive as `git archive` writes it. Each entry has a
// ustar header, whose path is split between its prefix and name fields when
// the name field is too short; a pax extended header ("x") before it holds the
// path, or the size, when the ustar header can't. A global pax header ("g")
// holds a commit's id and is no entry. Directories, and submodules, end with a
// slash.
export function tarPaths(tar) {
  const paths = []
  let extended = {}
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512)
    if (header.every((byte) => byte === 0)) break
    const field = (offset, length) => {
      const bytes = header.subarray(offset, offset + length)
      const nul = bytes.indexOf(0)
      return (nul === -1 ? bytes : bytes.subarray(0, nul)).toString("utf8")
    }
    if (field(257, 6) !== "ustar") throw new Error(`git archive: no ustar header at byte ${at}`)
    const type = String.fromCharCode(header[156])
    const meta = type === "x" || type === "g"
    const size = !meta && extended.size !== undefined ? Number(extended.size) : parseInt(field(124, 12).trim() || "0", 8)
    const data = tar.subarray(at + 512, at + 512 + size)
    at += 512 + Math.ceil(size / 512) * 512
    if (type === "x") extended = paxRecords(data)
    if (meta) continue
    const prefix = field(345, 155)
    paths.push(extended.path ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100)))
    extended = {}
  }
  return paths
}

// A pax header's records, each "<length> <key>=<value>\n", as { key: value }.
function paxRecords(data) {
  const records = {}
  for (let at = 0; at < data.length; ) {
    const space = data.indexOf(0x20, at)
    const length = Number(data.subarray(at, space).toString("utf8"))
    if (space === -1 || !(length > 0)) throw new Error("git archive: a bad pax record")
    const record = data.subarray(space + 1, at + length - 1).toString("utf8")
    const equals = record.indexOf("=")
    records[record.slice(0, equals)] = record.slice(equals + 1)
    at += length
  }
  return records
}

// The paths `git archive` exports from the index, written as a tree. A copy of
// the index is written into a temporary object directory that borrows the
// repository's objects, so neither the index nor the repository changes.
function archivedPaths(root) {
  const [index, objects] = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index", "--git-path", "objects"])
    .toString("utf8")
    .trim()
    .split("\n")
  const scratch = mkdtempSync(join(tmpdir(), "check-repo-"))
  try {
    mkdirSync(join(scratch, "objects"))
    copyFileSync(index, join(scratch, "index"))
    const env = {
      ...process.env,
      GIT_INDEX_FILE: join(scratch, "index"),
      GIT_OBJECT_DIRECTORY: join(scratch, "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: [objects, process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES].filter(Boolean).join(delimiter),
    }
    let tree
    try {
      tree = execFileSync("git", ["write-tree"], { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
    } catch (error) {
      const why = String(error.stderr ?? "").trim().split("\n").pop()
      throw new Error(`the index can't be written as a tree (unmerged entries? resolve them first): ${why}`)
    }
    return tarPaths(git(root, ["archive", "--format=tar", tree], undefined, env))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// The index entries `git archive` would export, from the archive of the index
// written as a tree: a file, or a symbolic link, by its path; a submodule by its
// directory ("sub/"). It throws if the archive holds a file that isn't one of
// the entries, so nothing exported can go unchecked.
export function exportedEntries(root, entries) {
  if (entries.length === 0) return []
  const archived = archivedPaths(root)
  const files = new Set(archived.filter((p) => !p.endsWith("/")))
  const directories = new Set(archived.filter((p) => p.endsWith("/")).map((p) => p.slice(0, -1)))
  const paths = new Set(entries.map((e) => e.path))
  const unknown = [...files].filter((p) => !paths.has(p))
  if (unknown.length > 0) throw new Error(`git archive exports ${unknown.length} file(s) that aren't in the index, such as ${unknown[0]}`)
  return entries.filter((e) => (e.mode === "160000" ? directories : files).has(e.path))
}

// The blobs' contents, read in one `git cat-file --batch`: each answer is
// "<oid> blob <size>\n", the bytes, then "\n".
function readBlobs(root, oids) {
  const out = git(root, ["cat-file", "--batch"], oids.map((oid) => `${oid}\n`).join(""))
  const blobs = new Map()
  let at = 0
  for (const oid of oids) {
    const eol = out.indexOf(0x0a, at)
    const header = out.subarray(at, eol).toString("utf8").split(" ")
    if (header[0] !== oid || header[1] !== "blob") throw new Error(`git cat-file: unexpected answer for ${oid}`)
    const size = Number(header[2])
    blobs.set(oid, out.subarray(eol + 1, eol + 1 + size))
    at = eol + 1 + size + 1
  }
  return blobs
}

function main() {
  const check = "repository check"
  const root = repositoryRoot(check)
  const { terms, source } = denyTermsOrExit(root, check)
  const tracked = indexEntries(root)
  let entries
  try {
    entries = exportedEntries(root, tracked)
  } catch (error) {
    console.error(`${check} failed: ${error.message}`)
    process.exit(2)
  }
  // A submodule's entry (mode 160000) is a commit, with no blob to read.
  const files = entries.filter((e) => e.mode !== "160000")
  const blobs = readBlobs(root, [...new Set(files.map((e) => e.oid))])

  const problems = []
  const notes = []
  let scanned = 0
  for (const { path } of entries) {
    for (const hit of termsIn(path, terms, path)) problems.push(`${path}: in the file name: ${hit}`)
  }
  for (const { path, oid } of files) {
    const buffer = blobs.get(oid)
    if (!isText(buffer)) {
      notes.push(`not scanned (binary): ${path}`)
      continue
    }
    scanned++
    for (const hit of internalReferences(buffer.toString("utf8"), terms, path)) problems.push(`${path}:${hit}`)
  }

  for (const note of notes) console.log(`note: ${note}`)
  if (problems.length > 0) {
    console.error(`${check} failed (${problems.length}):`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log(
    `repository ok: ${entries.length} exported files of ${tracked.length} tracked, ${scanned} scanned (private terms from ${source})`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main()
