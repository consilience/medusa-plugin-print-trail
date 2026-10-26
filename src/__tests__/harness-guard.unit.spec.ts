// The HTTP harness's fixture config must refuse to load with any Print Trail
// host but the local mock, so a harness run can never reach a real one.
import path from "node:path"

const config = path.resolve(__dirname, "../../integration-tests/http/app/medusa-config.ts")

describe("HTTP harness fixture", () => {
  const saved = process.env.PT_HARNESS_OPTIONS
  afterEach(() => {
    if (saved === undefined) delete process.env.PT_HARNESS_OPTIONS
    else process.env.PT_HARNESS_OPTIONS = saved
  })

  const load = () => jest.isolateModules(() => require(config))

  it("loads with the mock's base URL", () => {
    delete process.env.PT_HARNESS_OPTIONS
    expect(load).not.toThrow()
  })

  it.each(["https://api.printtrail.com", "https://printtrail-core.consilstaging.com", "http://localhost:4310"])(
    "refuses to load with baseUrl %s",
    (baseUrl) => {
      process.env.PT_HARNESS_OPTIONS = JSON.stringify({ baseUrl })
      expect(load).toThrow(/refusing Print Trail host/)
    }
  )
})
