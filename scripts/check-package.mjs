#!/usr/bin/env node
// Checks what `npm pack` would ship: no tests, no mock, no integration tests,
// staging checklist or CONTRIBUTING.md, every `exports` target present, the
// README, changelog and licence included, no comments in the compiled server
// code or its declarations, no declaration naming a package that isn't a peer
// or dependency (or a path into node_modules, or an absolute one), no binary
// file in the server code, and no internal references
// in any packed file's name or text (scripts/deny-terms.mjs: the generic
// patterns and the maintainers' private term list, without which the check
// fails). Run after `npm run build`. The checks on file contents are exported,
// so they can be tried on a planted file without a build.
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { builtinModules } from "node:module"
import { join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import ts from "typescript"
import { denyTermsOrExit, internalReferences, isText, termsIn } from "./deny-terms.mjs"

export { internalReferences, isText }

// Binary files that may ship under .medusa/server, each with its reason. None
// today: the build emits only JavaScript.
const allowedBinaries = new Map()

// A compiled file is parsed as TypeScript when it is a declaration file.
const scriptKind = (fileName) => (/\.d\.[cm]?ts$/.test(fileName) ? ts.ScriptKind.TS : ts.ScriptKind.JS)

// The comments in a compiled JavaScript or declaration file, as { line, text },
// except the source map URL. They are found by parsing, not by line: every
// comment sits in the trivia before some token, so the leading and trailing
// comment ranges at each node's and each token's edges are all of them, while
// a string, template literal or regular expression that holds `//` or `/*` is
// a single token and never read as trivia. The server build emits no
// /* @__PURE__ */ annotations (only the admin bundle has them), so none is
// allowed. Nor is a triple-slash directive in a declaration file: a
// `/// <reference types>` would make every store install that package's types.
const allowedComment = /^\/\/[#@] sourceMappingURL=/
export function commentsIn(text, fileName = "file.js") {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName))
  const ranges = new Map()
  const collect = (pos) => {
    for (const range of ts.getLeadingCommentRanges(text, pos) ?? []) ranges.set(range.pos, range)
    for (const range of ts.getTrailingCommentRanges(text, pos) ?? []) ranges.set(range.pos, range)
  }
  const visit = (node) => {
    collect(node.pos)
    collect(node.end)
    // A JSDoc node lies inside its comment, which its parent's edge has found.
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return
    for (const child of node.getChildren(source)) visit(child)
  }
  visit(source)
  return [...ranges.values()]
    .sort((a, b) => a.pos - b.pos)
    .map((range) => ({
      line: source.getLineAndCharacterOfPosition(range.pos).line + 1,
      text: text.slice(range.pos, range.end),
    }))
    .filter((comment) => !allowedComment.test(comment.text))
}

// The packed files checked for comments: the server code compiled with
// `removeComments` (tsconfig.json) and every declaration file. The admin
// bundle is built separately and keeps its /* @__PURE__ */ annotations, so its
// JavaScript isn't checked.
export function isCheckedForComments(path) {
  if (!path.startsWith(".medusa/server/")) return false
  if (/\.d\.[cm]?ts$/.test(path)) return true
  return /\.[cm]?js$/.test(path) && !path.startsWith(".medusa/server/src/admin/")
}

// A specifier that is an absolute path or reaches into node_modules: it
// resolves only where the package was built, whichever packages it names.
export const isBuildPath = (specifier) => specifier.startsWith("/") || specifier.includes("node_modules/")

// The module specifiers a declaration file names that point outside the
// package, in order and once each: import and export-from declarations,
// `import("…")` types and `import x = require("…")`. That is every bare
// specifier, and every path isBuildPath reports; other relative paths are
// left out.
export function externalSpecifiers(text, fileName = "file.d.ts") {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName))
  const found = []
  const add = (node) => {
    if (!node || !ts.isStringLiteralLike(node) || found.includes(node.text)) return
    if (isBuildPath(node.text) || !/^\.{0,2}\//.test(node.text)) found.push(node.text)
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier)
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal)
    else if (ts.isExternalModuleReference(node)) add(node.expression)
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0])
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

// The packages among `specifiers` that a store isn't sure to have: not Node's
// own modules, and not in `pkg`'s peerDependencies or dependencies. A
// declaration that names a package installed only as a dependency of a peer
// (@medusajs/types under @medusajs/framework, say) gives a store errors or
// `any`, depending on where its package manager put it. A build path
// (isBuildPath) names no package a store could have, so it is listed whole.
const packageOf = (specifier) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/")
export function undeclaredPackages(specifiers, pkg) {
  const declared = new Set([...Object.keys(pkg.peerDependencies ?? {}), ...Object.keys(pkg.dependencies ?? {})])
  const builtin = new Set(builtinModules)
  const undeclared = []
  for (const specifier of specifiers) {
    if (isBuildPath(specifier)) {
      if (!undeclared.includes(specifier)) undeclared.push(specifier)
      continue
    }
    if (specifier.startsWith("node:") || builtin.has(packageOf(specifier))) continue
    const name = packageOf(specifier)
    if (!declared.has(name) && !undeclared.includes(name)) undeclared.push(name)
  }
  return undeclared
}

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url))
  const { terms, source } = denyTermsOrExit(root, "package check")
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))

  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  const packed = JSON.parse(out)[0]
  const files = new Set(packed.files.map((f) => f.path))
  const problems = []
  const notes = []

  const forbidden = [
    /__tests__\//, /^\.medusa\/server\/dev\//, /(^|\/)integration-tests\//, /(^|\/)scripts\/staging-checklist\//,
    /^CONTRIBUTING\.md$/,
  ]
  for (const path of files) {
    if (forbidden.some((re) => re.test(path))) {
      problems.push(`ships a file it must not: ${path}`)
    }
  }

  function walk(dir) {
    if (!existsSync(dir)) return []
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name)
      return statSync(full).isDirectory() ? walk(full) : [full]
    })
  }

  // Every target in `exports`, with "*" expanded against the built files.
  const targets = []
  function collect(value) {
    if (typeof value === "string") targets.push(value)
    else if (value && typeof value === "object") Object.values(value).forEach(collect)
  }
  collect(pkg.exports ?? {})

  const built = walk(join(root, ".medusa/server")).map((f) => relative(root, f))
  for (const target of targets) {
    const path = target.replace(/^\.\//, "")
    if (!path.includes("*")) {
      if (!files.has(path)) problems.push(`exports target not packed: ${target}`)
      continue
    }
    const re = new RegExp(
      "^" + path.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("([^/]+)") + "$"
    )
    const matches = built.filter((f) => re.test(f) && !forbidden.some((bad) => bad.test(f)))
    if (matches.length === 0) problems.push(`exports pattern matches no built file: ${target}`)
    for (const match of matches) {
      if (!files.has(match)) problems.push(`exports target not packed: ${match} (from ${target})`)
    }
  }

  // The package declares `SEE LICENSE IN LICENSE`, so the licence always ships.
  for (const required of ["README.md", "CHANGELOG.md", "LICENSE"]) {
    if (!files.has(required)) problems.push(`missing from the package: ${required}`)
  }

  // Source comments are for this repository, not the package.
  for (const path of files) {
    if (!isCheckedForComments(path)) continue
    for (const comment of commentsIn(readFileSync(join(root, path), "utf8"), path)) {
      problems.push(`comment in compiled code: ${path}:${comment.line}: ${comment.text.slice(0, 60)}`)
    }
  }

  // A declaration may name only packages a store is sure to have.
  for (const path of files) {
    if (!/^\.medusa\/server\/.*\.d\.[cm]?ts$/.test(path)) continue
    for (const name of undeclaredPackages(externalSpecifiers(readFileSync(join(root, path), "utf8"), path), pkg)) {
      problems.push(
        isBuildPath(name)
          ? `declaration names a path that only resolves where the package was built: ${path}: ${name}`
          : `declaration names a package that isn't a peer or dependency: ${path}: ${name}`
      )
    }
  }

  // Every packed text file is scanned, decided by content, not extension. A
  // binary file can't be scanned, so none may ship in the server code.
  for (const path of files) {
    for (const hit of termsIn(path, terms, path)) problems.push(`internal reference in a file name: ${path}: ${hit}`)
    const buffer = readFileSync(join(root, path))
    if (!isText(buffer)) {
      if (!path.startsWith(".medusa/server/")) notes.push(`not scanned (binary): ${path}`)
      else if (!allowedBinaries.has(path)) problems.push(`binary file in the server code: ${path}`)
      continue
    }
    for (const hit of internalReferences(buffer.toString("utf8"), terms, path)) {
      problems.push(`internal reference at ${path}:${hit}`)
    }
  }

  for (const note of notes) console.log(`note: ${note}`)
  if (problems.length > 0) {
    console.error(`package check failed (${problems.length}):`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log(`package ok: ${files.size} files (private terms from ${source})`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main()
