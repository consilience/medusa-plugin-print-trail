#!/usr/bin/env node
// Checks the installed package's `exports` from a consumer project:
//   node scripts/check-exports.cjs <consumer dir>
// Run by scripts/install-test.sh after installing the packed tarball there
// with Medusa. Exits non-zero on any failure.
//
// - Every public entry resolves from the consumer and loads, and the main
//   functions are there.
// - ./admin resolves under `require` and under `import` (Medusa's admin
//   bundler uses both).
// - Medusa's own plugin resolution gives a module path and an admin entry
//   that resolve.
// - A deep import of an internal file fails with ERR_PACKAGE_PATH_NOT_EXPORTED.
"use strict"

const { execFileSync } = require("node:child_process")
const { mkdtempSync, realpathSync, rmSync, writeFileSync } = require("node:fs")
const { createRequire } = require("node:module")
const path = require("node:path")
const { fileURLToPath } = require("node:url")

const NAME = "medusa-plugin-print-trail"
const dir = realpathSync(path.resolve(process.argv[2] ?? "."))
const failures = []
const fail = (msg) => failures.push(msg)

// Resolves as a file in the consumer would. `require.resolve(s, { paths })`
// from here would try this checkout's own package name first (a package can
// import itself by name), and so check the checkout instead of the install.
const consumerRequire = createRequire(path.join(dir, "check-exports.cjs"))
const installed = path.join(dir, "node_modules", NAME) + path.sep
const resolveFrom = (specifier) => {
  const resolved = consumerRequire.resolve(specifier)
  if (specifier.startsWith(NAME) && !resolved.startsWith(installed)) throw new Error(`resolved to ${resolved}, outside ${installed}`)
  return resolved
}
const load = (specifier) => consumerRequire(resolveFrom(specifier))

function check(name, fn) {
  try {
    const result = fn()
    if (result) fail(`${name}: ${result}`)
    else console.log(`ok: ${name}`)
  } catch (e) {
    fail(`${name}: ${e && e.message ? e.message.split("\n")[0] : e}`)
  }
}

const isFunction = (mod, key) => (typeof mod[key] === "function" ? null : `${key} is ${typeof mod[key]}, not a function`)

// Each public entry, with what it must carry.
const entries = {
  "/config": (m) => isFunction(m, "printTrailOptionsFromEnv"),
  "/workflows": (m) => isFunction(m, "requestPrintTrailStockSyncWorkflow"),
  "/modules/printTrail": (m) => (m.default && m.default.linkable && m.default.linkable.printTrailOrder ? null : "no default.linkable.printTrailOrder"),
  "/providers/print-trail": (m) => (m.default && Array.isArray(m.default.services) ? null : "no default.services"),
  "/stock": (m) => isFunction(m, "requestStockSync") || isFunction(m, "describeStockResult"),
  "/shipping-options": (m) =>
    isFunction(m, "validateRateCard") || isFunction(m, "printTrailShippingOptionInput") || isFunction(m, "printTrailShippingMethods"),
}
for (const [entry, expect] of Object.entries(entries)) {
  check(`${NAME}${entry}`, () => expect(load(NAME + entry)))
}
check(`${NAME}/package.json`, () => (load(`${NAME}/package.json`).name === NAME ? null : "wrong name"))

// ./admin under require, and under import through a generated module.
check(`${NAME}/admin (require)`, () => (resolveFrom(`${NAME}/admin`).endsWith(path.join("admin", "index.js")) ? null : "not admin/index.js"))
check(`${NAME}/admin (import)`, () => {
  const tmp = mkdtempSync(path.join(dir, ".check-exports-"))
  try {
    const script = path.join(tmp, "resolve.mjs")
    writeFileSync(script, `console.log(import.meta.resolve(${JSON.stringify(`${NAME}/admin`)}))\n`)
    const url = execFileSync(process.execPath, [script], { cwd: dir, encoding: "utf8" }).trim()
    const file = realpathSync(fileURLToPath(url))
    if (!file.startsWith(installed)) return `resolved to ${file}, outside ${installed}`
    return file.endsWith(path.join("admin", "index.mjs")) ? null : `resolved to ${file}, not admin/index.mjs`
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// What Medusa itself resolves when a store lists the plugin.
async function medusaResolution() {
  const { getResolvedPlugins } = require(resolveFrom("@medusajs/framework/utils"))
  const [plugin] = await getResolvedPlugins(dir, { plugins: [{ resolve: NAME, options: {} }] })
  if (!plugin) return fail("getResolvedPlugins: no plugin")
  check("getResolvedPlugins: the plugin's source directory", () => {
    if (!realpathSync(plugin.resolve).startsWith(installed)) return `${plugin.resolve} is outside ${installed}`
    return null
  })
  check("getResolvedPlugins: a module path that resolves", () => {
    if (!plugin.modules.length) return "no modules"
    for (const mod of plugin.modules) resolveFrom(mod.resolve)
    return null
  })
  check("getResolvedPlugins: an admin entry that resolves", () => {
    if (!plugin.admin || plugin.admin.type !== "package") return `admin is ${JSON.stringify(plugin.admin)}`
    resolveFrom(plugin.admin.resolve)
    return null
  })
}

// Internal files are not part of the API.
const internal = [
  "/lib/stock-request",
  "/lib/admin/shipping-options",
  "/lib/admin/shipping-options-routes",
  "/modules/printTrail/service",
  "/.medusa/server/src/lib/stock-request",
]

medusaResolution()
  .catch((e) => fail(`getResolvedPlugins: ${e && e.message ? e.message : e}`))
  .then(() => {
    for (const deep of internal) {
      check(`${NAME}${deep} is not exported`, () => {
        try {
          resolveFrom(NAME + deep)
        } catch (e) {
          return e && e.code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ? null : `failed with ${e && e.code}, not ERR_PACKAGE_PATH_NOT_EXPORTED`
        }
        return "resolved"
      })
    }
    if (failures.length) {
      for (const f of failures) console.error(`FAIL: ${f}`)
      process.exit(1)
    }
    console.log(`exports ok from ${dir}`)
  })
