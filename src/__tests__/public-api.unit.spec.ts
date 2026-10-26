import fs from "node:fs"
import path from "node:path"
import * as shippingOptions from "../shipping-options"
import * as stock from "../stock"

// The package's public entry points. Anything else under .medusa/server is
// internal: `exports` lists each entry, with no pattern a store could reach
// a deep path through.
describe("the public API", () => {
  it("stock exports the stock sync's entry point", () => {
    expect(typeof stock.requestStockSync).toBe("function")
    expect(typeof stock.describeStockResult).toBe("function")
    expect(Object.keys(stock).sort()).toEqual(["describeStockResult", "requestStockSync"])
  })

  it("shipping-options exports rate-card validation and the shipping option input", () => {
    expect(typeof shippingOptions.validateRateCard).toBe("function")
    expect(typeof shippingOptions.printTrailShippingOptionInput).toBe("function")
    expect(typeof shippingOptions.printTrailShippingMethods).toBe("function")
    expect(Object.keys(shippingOptions).sort()).toEqual(["printTrailShippingMethods", "printTrailShippingOptionInput", "validateRateCard"])
  })

  it("package.json exports exactly the public entries, with no pattern", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"))
    expect(Object.keys(pkg.exports)).toEqual([
      "./package.json",
      "./.medusa/server/src/modules/printTrail",
      "./config",
      "./workflows",
      "./modules/printTrail",
      "./providers/print-trail",
      "./stock",
      "./shipping-options",
      "./admin",
    ])
    expect(JSON.stringify(pkg.exports)).not.toContain("*")
    // Medusa's admin bundler resolves ./admin under require and import.
    expect(pkg.exports["./admin"]).toEqual({
      import: "./.medusa/server/src/admin/index.mjs",
      require: "./.medusa/server/src/admin/index.js",
      default: "./.medusa/server/src/admin/index.js",
    })
  })

  it("each public entry has its declaration file, listed before the code", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"))
    const typed = ["./config", "./workflows", "./modules/printTrail", "./providers/print-trail", "./stock", "./shipping-options"]
    for (const key of typed) {
      const entry = pkg.exports[key]
      expect(Object.keys(entry)).toEqual(["types", "default"])
      expect(entry.types).toBe(entry.default.replace(/\.js$/, ".d.ts"))
    }
    // Only Medusa's loader uses the module's path, and the admin build has no declarations.
    expect(typeof pkg.exports["./.medusa/server/src/modules/printTrail"]).toBe("string")
    expect(pkg.exports["./admin"]).not.toHaveProperty("types")
    expect(pkg).not.toHaveProperty("typesVersions")
  })
})
