import {
  readWebhookSecrets,
  SECRET_GRACE_MS,
  storeWebhookSecret,
  WEBHOOK_SECRET_STATE_KEY,
} from "../webhook-secret"

const TOKEN = "api-token-1234567890"
const A = "a1".repeat(32)
const B = "b2".repeat(32)
const NOW = new Date("2026-10-19T12:00:00Z")
const at = (ms: number) => new Date(NOW.getTime() + ms)

const memory = () => {
  const map = new Map<string, unknown>()
  return {
    map,
    async getState<T>(key: string) {
      return (map.has(key) ? structuredClone(map.get(key)) : null) as T | null
    },
    async setState(key: string, value: unknown) {
      map.set(key, structuredClone(value))
    },
  }
}

describe("stored webhook secret", () => {
  it("stores and reads back a secret", async () => {
    const state = memory()
    expect(await storeWebhookSecret(state, TOKEN, A, NOW)).toBe("stored")
    expect(await readWebhookSecrets(state, { apiToken: TOKEN }, NOW)).toEqual({ secrets: [A], source: "print-trail", mismatch: false })
    expect(await storeWebhookSecret(state, TOKEN, A, at(1000))).toBe("unchanged")
  })

  it("the stored row holds no plain secret", async () => {
    const state = memory()
    await storeWebhookSecret(state, TOKEN, A, NOW)
    await storeWebhookSecret(state, TOKEN, B, NOW)
    const text = JSON.stringify(state.map.get(WEBHOOK_SECRET_STATE_KEY))
    expect(text).not.toContain(A)
    expect(text).not.toContain(B)
    expect(text).not.toContain(TOKEN)
  })

  it("a secret stored under another token reads as absent", async () => {
    const state = memory()
    await storeWebhookSecret(state, TOKEN, A, NOW)
    expect(await readWebhookSecrets(state, { apiToken: "another-token-value" }, NOW)).toEqual({ secrets: [], source: null, mismatch: false })
    expect(await readWebhookSecrets(state, { apiToken: "another-token-value", webhookSecret: B }, NOW)).toEqual({
      secrets: [B],
      source: "configured",
      mismatch: false,
    })
  })

  it("a tampered row reads as absent", async () => {
    const state = memory()
    await storeWebhookSecret(state, TOKEN, A, NOW)
    const row = state.map.get(WEBHOOK_SECRET_STATE_KEY) as any
    row.current.data = Buffer.from("x".repeat(64)).toString("base64")
    expect((await readWebhookSecrets(state, { apiToken: TOKEN }, NOW)).secrets).toEqual([])
    await storeWebhookSecret(state, TOKEN, A, NOW)
    const short = state.map.get(WEBHOOK_SECRET_STATE_KEY) as any
    short.current.tag = Buffer.from(short.current.tag, "base64").subarray(0, 4).toString("base64")
    expect((await readWebhookSecrets(state, { apiToken: TOKEN }, NOW)).secrets).toEqual([])
    state.map.set(WEBHOOK_SECRET_STATE_KEY, { v: 9 })
    expect((await readWebhookSecrets(state, { apiToken: TOKEN }, NOW)).secrets).toEqual([])
  })

  it("a row whose grace or stored time was edited reads as absent", async () => {
    for (const field of ["previousUntil", "storedAt"]) {
      const state = memory()
      await storeWebhookSecret(state, TOKEN, A, NOW)
      await storeWebhookSecret(state, TOKEN, B, NOW)
      const row = state.map.get(WEBHOOK_SECRET_STATE_KEY) as any
      row[field] = new Date(NOW.getTime() + 365 * 86400_000).toISOString()
      expect(await readWebhookSecrets(state, { apiToken: TOKEN }, at(4 * 3600_000 + 60_000))).toEqual({ secrets: [], source: null, mismatch: false })
    }
  })

  it("swapping the current and previous seals makes the row unreadable", async () => {
    const state = memory()
    await storeWebhookSecret(state, TOKEN, A, NOW)
    await storeWebhookSecret(state, TOKEN, B, NOW)
    const row = state.map.get(WEBHOOK_SECRET_STATE_KEY) as any
    ;[row.current, row.previous] = [row.previous, row.current]
    expect(await readWebhookSecrets(state, { apiToken: TOKEN }, at(60_000))).toEqual({ secrets: [], source: null, mismatch: false })
  })

  it("a previous seal copied over the current one is refused", async () => {
    const state = memory()
    await storeWebhookSecret(state, TOKEN, A, NOW)
    await storeWebhookSecret(state, TOKEN, B, NOW)
    const row = state.map.get(WEBHOOK_SECRET_STATE_KEY) as any
    row.current = row.previous
    expect((await readWebhookSecrets(state, { apiToken: TOKEN }, at(60_000))).secrets).toEqual([])
  })

  it("two seals of the same secret differ (a fresh IV each time)", async () => {
    const one = memory()
    const two = memory()
    await storeWebhookSecret(one, TOKEN, A, NOW)
    await storeWebhookSecret(two, TOKEN, A, NOW)
    const x = one.map.get(WEBHOOK_SECRET_STATE_KEY) as any
    const y = two.map.get(WEBHOOK_SECRET_STATE_KEY) as any
    expect(x.current.iv).not.toBe(y.current.iv)
    expect(x.current.data).not.toBe(y.current.data)
  })

  it("a changed secret keeps the old one for four hours", async () => {
    expect(SECRET_GRACE_MS).toBe(4 * 3600_000)
    const state = memory()
    await storeWebhookSecret(state, TOKEN, A, NOW)
    await storeWebhookSecret(state, TOKEN, B, NOW)
    expect((await readWebhookSecrets(state, { apiToken: TOKEN }, at(4 * 3600_000 - 60_000))).secrets).toEqual([B, A])
    expect((await readWebhookSecrets(state, { apiToken: TOKEN }, at(4 * 3600_000 + 60_000))).secrets).toEqual([B])
  })

  it("re-storing the current secret keeps the grace for the previous one", async () => {
    const state = memory()
    await storeWebhookSecret(state, TOKEN, A, NOW)
    await storeWebhookSecret(state, TOKEN, B, NOW)
    await storeWebhookSecret(state, TOKEN, B, at(60_000))
    expect((await readWebhookSecrets(state, { apiToken: TOKEN }, at(2 * 60_000))).secrets).toEqual([B, A])
  })

  it("the stored secret wins over the configured one, and a difference is a mismatch", async () => {
    const state = memory()
    await storeWebhookSecret(state, TOKEN, A, NOW)
    expect(await readWebhookSecrets(state, { apiToken: TOKEN, webhookSecret: B }, NOW)).toEqual({
      secrets: [A],
      source: "print-trail",
      mismatch: true,
    })
    expect((await readWebhookSecrets(state, { apiToken: TOKEN, webhookSecret: A }, NOW)).mismatch).toBe(false)
  })

  it("falls back to the configured secret, or none", async () => {
    const state = memory()
    expect(await readWebhookSecrets(state, { apiToken: TOKEN, webhookSecret: B }, NOW)).toEqual({ secrets: [B], source: "configured", mismatch: false })
    expect(await readWebhookSecrets(state, { apiToken: TOKEN }, NOW)).toEqual({ secrets: [], source: null, mismatch: false })
    expect(await readWebhookSecrets(state, {}, NOW)).toEqual({ secrets: [], source: null, mismatch: false })
  })

  it("never stores without a token", async () => {
    const state = memory()
    expect(await storeWebhookSecret(state, "", A, NOW)).toBe("unchanged")
    expect(state.map.size).toBe(0)
  })
})
