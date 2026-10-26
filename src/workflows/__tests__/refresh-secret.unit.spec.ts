import { resolvePluginOptions } from "../../config"
import { PRINT_TRAIL_MODULE } from "../../modules/printTrail"
import { SECRET_REFRESH_STATE_KEY } from "../../lib/admin/connection"
import { storeWebhookSecret } from "../../lib/webhook-secret"
import { refreshSecretFor } from "../refresh-print-trail-webhook-secret"

const options = resolvePluginOptions({ baseUrl: "http://127.0.0.1:1", channelId: "acme-medusa1", apiToken: "refresh-token-123" })

// Only the printTrail service: anything else (query, locking) throws, so a
// test passes only if the normal sweep needs neither.
const containerWith = (map: Map<string, unknown>) => {
  const service = {
    isConnected: async () => true,
    getOptions: async () => options,
    getState: async (k: string) => (map.has(k) ? map.get(k) : null),
    setState: async (k: string, v: unknown) => void map.set(k, v),
  }
  return {
    resolve: (key: string) => {
      if (key === PRINT_TRAIL_MODULE) return service
      throw new Error(`resolved ${key}`)
    },
  } as never
}

describe("the sweep's secret refresh, before any lock or query", () => {
  it("a readable stored secret takes no lock and runs no query", async () => {
    const map = new Map<string, unknown>()
    const state = { getState: async (k: string) => (map.get(k) as never) ?? null, setState: async (k: string, v: unknown) => void map.set(k, v) }
    await storeWebhookSecret(state, options.apiToken, "a".repeat(64), new Date())
    await expect(refreshSecretFor(containerWith(map))).resolves.toBe("readable")
  })

  it("while backing off, takes no lock and runs no query", async () => {
    const map = new Map<string, unknown>([[SECRET_REFRESH_STATE_KEY, { nextAt: new Date(Date.now() + 3600_000).toISOString() }]])
    await expect(refreshSecretFor(containerWith(map))).resolves.toBe("cooling-down")
  })
})
