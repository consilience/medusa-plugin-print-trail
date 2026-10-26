import { resolvePluginOptions } from "../../config"
import { printTrailAppBase, printTrailAppUrl } from "../app-url"

describe("printTrailAppUrl", () => {
  it("turns an api. host into app.", () => {
    const o = { baseUrl: "https://api.printtrail.com" }
    expect(printTrailAppBase(o)).toBe("https://app.printtrail.com")
    expect(printTrailAppUrl(o, "acme", "u-1")).toBe("https://app.printtrail.com/acme/orders/u-1")
  })

  it("leaves any other host unchanged (staging serves the app itself)", () => {
    const o = { baseUrl: "https://printtrail-core.consilstaging.com" }
    expect(printTrailAppUrl(o, "acme", "u-1")).toBe(
      "https://printtrail-core.consilstaging.com/acme/orders/u-1"
    )
  })

  it("matches api. case-insensitively, once", () => {
    expect(printTrailAppBase({ baseUrl: "HTTPS://API.example.com" })).toBe("HTTPS://app.example.com")
    expect(printTrailAppBase({ baseUrl: "https://api.api.example.com" })).toBe("https://app.api.example.com")
  })

  it("prefers the appUrl option, without its trailing slash", () => {
    const o = resolvePluginOptions({ baseUrl: "https://api.printtrail.com", appUrl: "https://app.custom/" })
    expect(printTrailAppUrl(o, "acme", "u-1")).toBe("https://app.custom/acme/orders/u-1")
  })

  it("encodes the team code", () => {
    expect(printTrailAppUrl({ baseUrl: "https://api.x" }, "a b", "u-1")).toBe("https://app.x/a%20b/orders/u-1")
  })

  it("is null without a team code, a uuid, or any base", () => {
    expect(printTrailAppUrl({ baseUrl: "https://api.x" }, null, "u-1")).toBeNull()
    expect(printTrailAppUrl({ baseUrl: "https://api.x" }, "acme", null)).toBeNull()
    expect(printTrailAppUrl({ baseUrl: undefined }, "acme", "u-1")).toBeNull()
    expect(printTrailAppBase({ baseUrl: undefined })).toBeNull()
  })
})
