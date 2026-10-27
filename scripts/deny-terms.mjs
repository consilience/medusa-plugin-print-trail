// The terms that must not appear in the package (check:package) or in any
// exported file (check:repo), and the scan both checks share.
//
// Two lists. The generic patterns below are public. The identifying terms
// (names, internal hosts, internal repositories and documents) are kept in the
// maintainers' private term list, which is loaded at run time; without it the
// checks fail rather than pass on the generic patterns alone.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

// A file is text when its first 8 KB hold no NUL byte (git's test), whatever
// its extension.
export const isText = (buffer) => !buffer.subarray(0, 8000).includes(0)

// Generic patterns: section-sign references, numbered plans and local home
// directories. The section sign is written as an escape so this file doesn't
// match itself.
export const genericTerms = [/\u00a7/, /\bplans? \d/i, /\/Users\//, /\/home\//]

// Any email address, except at a domain reserved for examples and tests
// (RFC 2606): example.com, example.org and example.net with any subdomain,
// and the .example, .test, .invalid and .localhost top-level domains.
const emailAddress = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
const allowedEmail = /@(?:[A-Za-z0-9-]+\.)*(?:example\.(?:com|org|net)|[A-Za-z0-9-]+\.(?:example|test|invalid|localhost))$/i

// Text that may appear although a term matches it, removed from a line before
// the line is scanned. `files`, when given, limits an entry to those paths.
export const allowedText = [
  // This repository, in GitHub URLs and repository slugs (not a longer name
  // that starts with it).
  { pattern: /consilience\/medusa-plugin-print-trail\b(?!-)/gi },
  // The package's former npm name, in the changelog's upgrade note.
  { pattern: /@consilience\/print-trail-medusa\b/gi },
  // The licensor.
  { pattern: /Consilience Media Limited/g, files: ["LICENSE", "package.json", "README.md"] },
  // Print Trail's staging API host, as the published OpenAPI document names it.
  { pattern: /printtrail-core\.consilstaging\.com/gi },
  // A dependency's deprecation notice, as npm records it.
  { pattern: /by contacting i@izs\.me/g, files: ["package-lock.json"] },
]

export class DenyTermsError extends Error {}

// The private term list's format: one regular expression per line, matched
// case-insensitively unless the line starts with "cs:". Blank lines and lines
// starting with "#" are skipped. The last line that isn't blank must be
// END_OF_LIST, so a list cut short (a secret pasted in part) is refused.
//
// A private term is reported by its line number in the list, never by its
// pattern: the reports go to CI logs, which may be public. For the same reason
// a line that doesn't compile is named by its number only (the engine's error
// message quotes the pattern).
export const END_OF_LIST = "# end of term list"

export function parseDenyTerms(text, source) {
  const lines = text.split(/\r?\n/).map((raw) => raw.trim())
  const last = lines.filter(Boolean).at(-1)
  if (last !== END_OF_LIST) {
    throw new DenyTermsError(`the private term list from ${source} doesn't end with "${END_OF_LIST}", so it may be cut short`)
  }
  const terms = []
  lines.forEach((line, i) => {
    if (!line || line.startsWith("#")) return
    const caseSensitive = line.startsWith("cs:")
    const body = caseSensitive ? line.slice(3) : line
    let re
    try {
      re = new RegExp(body, caseSensitive ? "" : "i")
    } catch {
      throw new DenyTermsError(`${source}:${i + 1}: not a regular expression`)
    }
    terms.push({ re, name: `private term ${i + 1}` })
  })
  return terms
}

// The git config key naming the term list's file, for a checkout that has it
// locally. A relative path is taken from the repository's root.
export const TERMS_FILE_KEY = "printTrail.denyTermsFile"

function configuredTermsFile(root) {
  try {
    const value = execFileSync("git", ["config", "--get", "--path", TERMS_FILE_KEY], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    return value || null
  } catch {
    // Unset (git exits 1), or no git: not configured.
    return null
  }
}

// The private terms, from the first source that is set: PT_DENY_TERMS (the
// list's contents; empty counts as unset, as a missing CI secret is empty),
// then the file PT_DENY_TERMS_FILE names, then the file the git config key
// TERMS_FILE_KEY names. Throws when none is set, when the named file is
// missing, when the list is cut short or has no terms, or when a line doesn't
// compile.
export function loadDenyTerms({ env = process.env, root }) {
  let text
  let source
  const read = (file, what) => {
    if (!existsSync(file)) throw new DenyTermsError(`${what} names ${file}, which doesn't exist`)
    text = readFileSync(file, "utf8")
    source = file
  }
  if (env.PT_DENY_TERMS && env.PT_DENY_TERMS.trim()) {
    text = env.PT_DENY_TERMS
    source = "PT_DENY_TERMS"
  } else if (env.PT_DENY_TERMS_FILE && env.PT_DENY_TERMS_FILE.trim()) {
    read(resolve(env.PT_DENY_TERMS_FILE), "PT_DENY_TERMS_FILE")
  } else {
    const configured = configuredTermsFile(root)
    if (!configured) {
      throw new DenyTermsError(
        "no private term list: set PT_DENY_TERMS to its contents, PT_DENY_TERMS_FILE to its path, " +
          `or the git config key ${TERMS_FILE_KEY} to its path (relative to the repository root)`
      )
    }
    read(resolve(root, configured), `git config ${TERMS_FILE_KEY}`)
  }
  const terms = parseDenyTerms(text, source)
  if (terms.length === 0) throw new DenyTermsError(`the private term list from ${source} has no terms`)
  return { terms, source }
}

const allowedFor = (path) => allowedText.filter((a) => !a.files || (path !== undefined && a.files.includes(path)))

// The terms and email addresses in one line, after the allowed text is removed.
export function termsIn(line, terms, path) {
  let scanned = line
  for (const { pattern } of allowedFor(path)) scanned = scanned.replace(pattern, " ")
  const hits = []
  for (const re of genericTerms) if (re.test(scanned)) hits.push(String(re))
  for (const { re, name } of terms) if (re.test(scanned)) hits.push(name)
  for (const [address] of scanned.matchAll(emailAddress)) {
    if (!allowedEmail.test(address)) hits.push(`email address ${address}`)
  }
  return hits
}

const sourceMapLine = /^\s*\/\/[#@] sourceMappingURL=/
const inlineMap = /^\s*\/\/[#@] sourceMappingURL=data:application\/json;(?:charset=[^;,]+;)?base64,(\S*)/
const stringsIn = (value) =>
  typeof value === "string" ? [value]
  : value && typeof value === "object" ? Object.values(value).flatMap(stringsIn)
  : []

// The internal references in a text file, as "line: term" strings. An inline
// source map is scanned decoded, without its base64 `mappings`, so a source
// embedded in it is caught and the base64 can't match by chance.
export function internalReferences(text, terms, path) {
  const hits = []
  text.split("\n").forEach((line, i) => {
    let scanned = line
    let where = `${i + 1}`
    const inline = inlineMap.exec(line)
    if (inline) {
      try {
        const sourceMap = JSON.parse(Buffer.from(inline[1], "base64").toString("utf8"))
        delete sourceMap.mappings
        scanned = stringsIn(sourceMap).join("\n")
        where += " (inline source map)"
      } catch {
        hits.push(`${where}: an inline source map that can't be read`)
        return
      }
    } else if (sourceMapLine.test(line) && /sourceMappingURL=data:/.test(line)) {
      hits.push(`${where}: an inline source map that can't be read`)
      return
    }
    for (const part of scanned.split("\n")) {
      for (const hit of termsIn(part, terms, path)) hits.push(`${where}: ${hit}`)
    }
  })
  return hits
}

// Loads the private terms or exits with the reason.
export function denyTermsOrExit(root, check) {
  try {
    return loadDenyTerms({ root })
  } catch (e) {
    if (!(e instanceof DenyTermsError)) throw e
    console.error(`${check} failed: ${e.message}`)
    console.error(`${check} needs the maintainers' term list and doesn't run without it.`)
    process.exit(2)
  }
}

