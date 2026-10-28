// integration-tests/setup.js refuses every request to the production Print
// Trail API, the plugin's default host, so a test that leaves out a base URL
// never reaches it.
import { startMockPrintTrail } from "../../dev/mock-print-trail"
import { resolvePluginOptions } from "../config"
import { PrintTrailClient } from "../modules/printTrail/client/client"

const REFUSED = /refusing a request to the production Print Trail API/

describe("the test setup's production guard", () => {
  // Before each test, so that without the guard no test sends anything.
  beforeEach(() => {
    expect(globalThis.fetch.name).toBe("refuseProductionFetch")
  })

  it("refuses the production host as a string, a URL, a Request or anything that stringifies to it", async () => {
    for (const input of [
      "https://api.printtrail.com/v1/channels/c/token",
      "HTTPS://API.PrintTrail.COM./v1",
      new URL("https://api.printtrail.com/v1"),
      new Request("https://api.printtrail.com/v1", { method: "POST" }),
      { toString: () => "https://api.printtrail.com/v1" } as unknown as string,
    ]) {
      await expect(fetch(input)).rejects.toThrow(REFUSED)
    }
  })

  it("fails a client built from options with no base URL", async () => {
    const o = resolvePluginOptions({ channelId: "acme-medusa1", apiToken: "tok" })
    const client = new PrintTrailClient({ baseUrl: o.baseUrl!, channelId: o.channelId!, apiToken: o.apiToken!, retryDelays: [] })
    await expect(client.getToken()).rejects.toThrow(REFUSED)
  })

  it("passes any other request to fetch", async () => {
    const mock = await startMockPrintTrail({ token: "tok", channelId: "acme-medusa1" })
    try {
      const client = new PrintTrailClient({ baseUrl: mock.url, channelId: "acme-medusa1", apiToken: "tok", retryDelays: [] })
      await expect(client.getToken()).resolves.toMatchObject({ channelId: "acme-medusa1" })
      const res = await fetch(new Request(`${mock.url}/v1/channels/acme-medusa1/token`, { headers: { Authorization: "Bearer tok" } }))
      expect(res.status).toBe(200)
    } finally {
      await mock.close()
    }
  })
})
