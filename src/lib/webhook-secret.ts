import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto"
import type { PrintTrailPluginOptions } from "../config"
import type { StateStore } from "./team-code"

// The channel's webhook signing secret, as POST /webhooks and the rotate
// route return it (API 1.1.0). Stored in print_trail_state, sealed with
// AES-256-GCM under a key derived from the API token, so the row alone (a
// database dump) doesn't give it away. A new token makes it unreadable, which
// reads as "not stored": Test connection fetches it again.
//
// Precedence: the stored secret wins. It is, by construction, what Print
// Trail returned to this token for this channel. The configured webhookSecret
// (PRINT_TRAIL_WEBHOOK_SECRET) is used only while nothing is stored, for an
// older Print Trail API that returns none; it is never accepted beside a
// stored one, so a rotated-out secret doesn't stay valid.

export const WEBHOOK_SECRET_STATE_KEY = "webhook_secret"

// After a change, the old secret is still accepted for this long: Print Trail
// signs a delivery once, when it is queued, so deliveries queued before the
// rotation (and their retries) carry the old signature. Print Trail (API 1.1.1)
// says to accept both "for a few hours": a failed delivery is retried up to 5
// times, waiting 10 s, 100 s, 1,000 s and 10,000 s, so an old-signed retry can
// arrive about 3 hours later. Four hours covers that with a margin; a delivery
// refused after the window is still caught by the reconcile poll.
export const SECRET_GRACE_MS = 4 * 3600_000

export type SecretSource = "print-trail" | "configured" | null

type Sealed = { iv: string; tag: string; data: string }
type StoredSecret = {
  v: 1
  current: Sealed
  previous: Sealed | null
  previousUntil: string | null
  storedAt: string
}

// "print-trail-medusa:webhook-secret:" is a frozen key-derivation and AAD
// label, not the package name: changing it makes every stored secret
// unreadable.
const keyFor = (apiToken: string) => createHash("sha256").update(`print-trail-medusa:webhook-secret:${apiToken}`).digest()

// The row's times and each seal's role are additional authenticated data, so
// a database writer can't extend the grace window or swap the current and
// previous secrets: an edited row reads as unreadable.
type Role = "current" | "previous"
const aadOf = (row: Pick<StoredSecret, "storedAt" | "previousUntil">, role: Role) =>
  Buffer.from(`print-trail-medusa:webhook-secret:v1|${role}|${row.storedAt}|${row.previousUntil ?? ""}`)

function seal(apiToken: string, secret: string, aad: Buffer): Sealed {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", keyFor(apiToken), iv)
  cipher.setAAD(aad)
  const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()])
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") }
}

// null for anything that doesn't decrypt: another token, a damaged row.
function unseal(apiToken: string, sealed: Sealed | null | undefined, aad: Buffer): string | null {
  if (!sealed || typeof sealed !== "object") return null
  try {
    const tag = Buffer.from(sealed.tag, "base64")
    // A full 16-byte tag only: a shortened one would weaken the check.
    if (tag.length !== 16) return null
    const decipher = createDecipheriv("aes-256-gcm", keyFor(apiToken), Buffer.from(sealed.iv, "base64"), { authTagLength: 16 })
    decipher.setAuthTag(tag)
    decipher.setAAD(aad)
    const out = Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8")
    return out || null
  } catch {
    return null
  }
}

const isStored = (v: unknown): v is StoredSecret => !!v && typeof v === "object" && (v as StoredSecret).v === 1

const same = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

async function readStored(state: StateStore, apiToken: string) {
  const row = await state.getState<StoredSecret>(WEBHOOK_SECRET_STATE_KEY)
  if (!isStored(row)) return null
  const current = unseal(apiToken, row.current, aadOf(row, "current"))
  if (!current) return null
  if (!row.previous) return { row, current, previous: null }
  const previous = unseal(apiToken, row.previous, aadOf(row, "previous"))
  // A previous seal that doesn't open is a tampered row: none of it is used.
  return previous ? { row, current, previous } : null
}

// Stores what Print Trail returned. A different secret replaces the current
// one, which is kept for SECRET_GRACE_MS.
export async function storeWebhookSecret(
  state: StateStore,
  apiToken: string | undefined,
  secret: string,
  now: Date
): Promise<"stored" | "unchanged"> {
  if (!apiToken || !secret) return "unchanged"
  const stored = await readStored(state, apiToken)
  if (stored && same(stored.current, secret)) return "unchanged"
  const times = {
    previousUntil: stored ? new Date(now.getTime() + SECRET_GRACE_MS).toISOString() : null,
    storedAt: now.toISOString(),
  }
  const value: StoredSecret = {
    v: 1,
    current: seal(apiToken, secret, aadOf(times, "current")),
    previous: stored ? seal(apiToken, stored.current, aadOf(times, "previous")) : null,
    ...times,
  }
  await state.setState(WEBHOOK_SECRET_STATE_KEY, value)
  return "stored"
}

// The secrets a webhook signature is checked against, newest first, and
// where they come from. mismatch: a configured secret that differs from the
// stored one (shown as a settings warning).
export async function readWebhookSecrets(
  state: StateStore,
  options: Partial<Pick<PrintTrailPluginOptions, "apiToken" | "webhookSecret">>,
  now: Date
): Promise<{ secrets: string[]; source: SecretSource; mismatch: boolean }> {
  const configured = options.webhookSecret || null
  const stored = options.apiToken ? await readStored(state, options.apiToken) : null
  if (stored) {
    const until = stored.row.previousUntil ? Date.parse(stored.row.previousUntil) : NaN
    const inGrace = !!stored.previous && Number.isFinite(until) && now.getTime() < until
    return {
      secrets: inGrace ? [stored.current, stored.previous!] : [stored.current],
      source: "print-trail",
      mismatch: !!configured && !same(configured, stored.current),
    }
  }
  return configured ? { secrets: [configured], source: "configured", mismatch: false } : { secrets: [], source: null, mismatch: false }
}

// Every secret the plugin knows, for scrubbing text before it is shown or
// logged.
export async function knownSecrets(
  state: StateStore,
  options: Partial<Pick<PrintTrailPluginOptions, "apiToken" | "webhookSecret">>
): Promise<string[]> {
  const stored = options.apiToken ? await readStored(state, options.apiToken) : null
  return [options.webhookSecret, stored?.current, stored?.previous].filter((s): s is string => !!s)
}
