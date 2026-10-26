import { spawnSync } from "node:child_process"
import path from "node:path"

// scripts/check-package.mjs is an ES module, so each case runs in its own
// Node process with the module's exports in scope as `m`.
const root = path.resolve(__dirname, "../..")
const module_ = path.join(root, "scripts/check-package.mjs")

function result(body: string) {
  const code = `import * as m from ${JSON.stringify(module_)}
    console.log(JSON.stringify(await (async () => { ${body} })()))`
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: root, encoding: "utf8" })
  if (r.status !== 0) throw new Error(r.stderr)
  return JSON.parse(r.stdout)
}

const comments = (text: string, fileName = "src/x.d.ts") =>
  result(`return m.commentsIn(${JSON.stringify(text)}, ${JSON.stringify(fileName)}).map((c) => c.text)`)

describe("comments in a declaration file", () => {
  it("reports a JSDoc comment, a line comment and a triple-slash directive", () => {
    expect(comments("/** The options. */\nexport declare const a: number;\n")).toEqual(["/** The options. */"])
    expect(comments("export declare const a: number; // why\n")).toEqual(["// why"])
    // A reference would make every store install @types/node.
    expect(comments('/// <reference types="node" />\nexport declare const a: number;\n')).toEqual([
      '/// <reference types="node" />',
    ])
  })

  it("reads TypeScript syntax, not just JavaScript", () => {
    expect(comments("export interface I {\n  /** field */\n  x: Array<string>;\n}\n")).toEqual(["/** field */"])
    expect(comments("export type U = `a${string}//b`;\nexport declare function f<T>(x: T): T;\n")).toEqual([])
  })

  it("every packed declaration under .medusa/server is checked, the admin bundle's JavaScript isn't", () => {
    const checked = result(`return [
      ".medusa/server/src/stock.d.ts",
      ".medusa/server/src/modules/printTrail/index.d.ts",
      ".medusa/server/src/admin/index.d.ts",
      ".medusa/server/src/stock.js",
      ".medusa/server/src/admin/index.js",
      ".medusa/server/src/admin/index.mjs",
      "README.md",
    ].filter(m.isCheckedForComments)`)
    expect(checked).toEqual([
      ".medusa/server/src/stock.d.ts",
      ".medusa/server/src/modules/printTrail/index.d.ts",
      ".medusa/server/src/admin/index.d.ts",
      ".medusa/server/src/stock.js",
    ])
  })
})

describe("packages a declaration file names", () => {
  const text = [
    'import type { MedusaContainer } from "@medusajs/framework/types";',
    'import { z } from "@medusajs/framework/zod";',
    'import * as flows from "@medusajs/medusa/core-flows";',
    'import type { Local } from "./local";',
    'export { other } from "../other";',
    'export * from "@medusajs/orchestration";',
    'declare const provider: import("@medusajs/types").ModuleProviderExports;',
    'import http = require("node:http");',
    'export type F = typeof import("./relative");',
    "export default provider;",
  ].join("\n")

  it("lists every bare specifier: imports, re-exports, import() types and import = require()", () => {
    expect(result(`return m.externalSpecifiers(${JSON.stringify(text)}, "src/x.d.ts")`)).toEqual([
      "@medusajs/framework/types",
      "@medusajs/framework/zod",
      "@medusajs/medusa/core-flows",
      "@medusajs/orchestration",
      "@medusajs/types",
      "node:http",
    ])
  })

  it("reports a package that isn't a peer or dependency, so a store's types can't depend on a transitive one", () => {
    const pkg = { peerDependencies: { "@medusajs/framework": "^2.17.2", "@medusajs/medusa": "^2.17.2" } }
    expect(
      result(`return m.undeclaredPackages(m.externalSpecifiers(${JSON.stringify(text)}, "src/x.d.ts"), ${JSON.stringify(pkg)})`)
    ).toEqual(["@medusajs/orchestration", "@medusajs/types"])
  })

  // A path into node_modules, or an absolute one, resolves only where the
  // package was built.
  const paths = [
    'import type { A } from "../../node_modules/@medusajs/types/dist/a";',
    'export * from "/opt/build/node_modules/@medusajs/types";',
    'declare const b: import("/opt/build/src/b").B;',
    'import c = require("./node_modules/c");',
    'import type { Local } from "./local";',
    'export { other } from "../other";',
  ].join("\n")

  it("lists a path into node_modules, or an absolute one, with the bare specifiers", () => {
    expect(result(`return m.externalSpecifiers(${JSON.stringify(paths)}, "src/x.d.ts")`)).toEqual([
      "../../node_modules/@medusajs/types/dist/a",
      "/opt/build/node_modules/@medusajs/types",
      "/opt/build/src/b",
      "./node_modules/c",
    ])
  })

  it("reports each such path whole, even one naming a peer", () => {
    const pkg = { peerDependencies: { "@medusajs/framework": "^2.17.2", "@medusajs/types": "^2.17.2" } }
    expect(
      result(`return m.undeclaredPackages(m.externalSpecifiers(${JSON.stringify(paths)}, "src/x.d.ts"), ${JSON.stringify(pkg)})`)
    ).toEqual(["../../node_modules/@medusajs/types/dist/a", "/opt/build/node_modules/@medusajs/types", "/opt/build/src/b", "./node_modules/c"])
  })

  it("accepts @medusajs/framework/utils, @medusajs/medusa/core-flows and Node's own modules", () => {
    const pkg = { peerDependencies: { "@medusajs/framework": "^2.17.2", "@medusajs/medusa": "^2.17.2" } }
    expect(
      result(`return m.undeclaredPackages(["@medusajs/framework/utils", "@medusajs/medusa/core-flows", "node:crypto", "crypto"], ${JSON.stringify(pkg)})`)
    ).toEqual([])
  })
})
