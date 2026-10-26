#!/usr/bin/env node
// Checks every tracked file for internal references, as the package check
// does for what ships: the file's name, and the text of every text file (text
// is decided by content, not extension; binary files are listed, not
// scanned). It reads the index (`git ls-files --stage`), so what is checked
// is what would be committed, whatever the working tree holds. The terms are
// scripts/deny-terms.mjs's generic patterns and the maintainers' private term
// list, without which the check fails; its allowed text is removed before a
// line is scanned.
import { execFileSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import { denyTermsOrExit, internalReferences, isText, termsIn } from "./deny-terms.mjs"

const git = (root, args, input) =>
  execFileSync("git", args, { cwd: root, input, maxBuffer: 256 * 1024 * 1024 })

// The index's entries, as { path, mode, oid }.
function indexEntries(root) {
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
  const root = fileURLToPath(new URL("..", import.meta.url))
  const { terms, source } = denyTermsOrExit(root, "repository check")
  const entries = indexEntries(root)
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
    console.error(`repository check failed (${problems.length}):`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log(`repository ok: ${entries.length} tracked files, ${scanned} scanned (private terms from ${source})`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main()
