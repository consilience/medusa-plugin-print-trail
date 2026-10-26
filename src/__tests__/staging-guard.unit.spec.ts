import { assertStagingTarget } from "../../integration-tests/staging/guard"

describe("staging smoke guard", () => {
  it("assertStagingTarget refuses production and unknown hosts", () => {
    for (const bad of [
      "https://api.printtrail.com",
      "https://printtrail.com.evil.test",
      "http://printtrail-core.consilstaging.com",
      "https://consilstaging.com.printtrail.com",
      "https://evilconsilstaging.com",
      "not a url",
      "",
      undefined,
    ]) {
      expect(() => assertStagingTarget(bad)).toThrow(/staging smoke/)
    }
    expect(assertStagingTarget("https://printtrail-core.consilstaging.com").host).toBe("printtrail-core.consilstaging.com")
    expect(assertStagingTarget("https://api.printtrail-core.consilstaging.com/").host).toBe(
      "api.printtrail-core.consilstaging.com"
    )
  })
})
