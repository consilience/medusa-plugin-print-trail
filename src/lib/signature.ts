import { createHmac, timingSafeEqual } from "crypto"

// Print Trail signs webhooks with the `Signature` header: hex HMAC-SHA256 of
// the raw body, keyed with the channel's webhook secret. Fails closed. Several
// secrets: the current one and, for a while after a rotation, the previous
// one; empty ones never match.
export function verifySignature(
  rawBody: Buffer | string,
  signature: string | undefined | null,
  secrets: string | readonly (string | null | undefined)[] | undefined | null
): boolean {
  const keys = (typeof secrets === "string" ? [secrets] : secrets ?? []).filter((s): s is string => !!s)
  if (!signature || !keys.length) {
    return false
  }
  const given = Buffer.from(signature.trim().toLowerCase())
  let ok = false
  for (const secret of keys) {
    const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"))
    // Every key is checked, so the time taken doesn't say which matched.
    if (given.length === expected.length && timingSafeEqual(given, expected)) ok = true
  }
  return ok
}
