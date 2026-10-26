// The checklist must never reach a store its user has put off limits,
// however the address is written. CHECKLIST_FORBIDDEN_STORE_URLS lists them,
// comma-separated (for example a store in daily use on this machine). It must
// be set, so a misspelt name fails closed; empty means none is forbidden.
//
// A host is local when it is a localhost name, a loopback, unspecified or
// IPv4-mapped loopback address, one of this machine's own addresses or its
// host name, or a name resolving to any of those. A forbidden URL on a local
// host, however that host is written, refuses any STORE_URL on its port whose
// host is local. Every forbidden URL also refuses a STORE_URL on its port
// whose host is the same name or address, or resolves to one of its
// addresses (a forbidden host that doesn't resolve is compared by name). On a
// forbidden port, a STORE_URL host that doesn't resolve is refused too.
import { lookup as dnsLookup } from "node:dns/promises"
import { isIP } from "node:net"
import { hostname as osHostname, networkInterfaces } from "node:os"

export const FORBIDDEN_STORES_ENV = "CHECKLIST_FORBIDDEN_STORE_URLS"
export class StoreGuardError extends Error {}

const refuse = (why: string): never => {
  throw new StoreGuardError(why)
}

// Lowercase, no IPv6 brackets, no trailing dots.
export function normaliseHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "")
}

// An IPv6 address as eight 16-bit groups, or null.
function ipv6Groups(ip: string): number[] | null {
  let s = ip.split("%")[0]
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (v4) {
    const parts = v4[1].split(".").map(Number)
    s = s.slice(0, -v4[1].length) + `${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`
  }
  const [head, tail] = s.split("::")
  const h = head ? head.split(":") : []
  const t = tail !== undefined && tail ? tail.split(":") : []
  const fill = s.includes("::") ? 8 - h.length - t.length : 0
  const groups = [...h, ...Array(fill).fill("0"), ...t].map((g) => parseInt(g || "0", 16))
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null
}

// The address in canonical form: IPv4-mapped IPv6 becomes IPv4.
export function canonicalIp(ip: string): string {
  const host = normaliseHost(ip)
  if (isIP(host) !== 6) return host
  const g = ipv6Groups(host)
  if (!g) return host
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join(".")
  }
  return g.map((x) => x.toString(16)).join(":")
}

export function isLoopbackOrUnspecified(ip: string): boolean {
  const c = canonicalIp(ip)
  if (isIP(c) === 4) return c.startsWith("127.") || c === "0.0.0.0"
  if (isIP(normaliseHost(ip)) === 6) return c === "0:0:0:0:0:0:0:1" || c === "0:0:0:0:0:0:0:0"
  return false
}

export function isLocalHostName(host: string): boolean {
  const h = normaliseHost(host)
  return h === "localhost" || h.endsWith(".localhost") || h === "localhost.localdomain"
}

export type GuardDeps = {
  lookup?: (host: string) => Promise<string[]>
  localAddresses?: () => string[]
  hostname?: () => string
}

const defaultLookup = async (host: string) => (await dnsLookup(host, { all: true })).map((a) => a.address)
const defaultLocalAddresses = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((a): a is NonNullable<typeof a> => !!a)
    .map((a) => a.address)

function parse(raw: string | undefined): URL {
  if (!raw) return refuse("STORE_URL is not set")
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return refuse("STORE_URL is not a URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") refuse("STORE_URL must be http or https")
  if (url.username || url.password) refuse("STORE_URL must not carry a user name or password")
  return url
}

const portOf = (url: URL) => url.port || (url.protocol === "https:" ? "443" : "80")

const isLocal = (host: string) => isLocalHostName(host) || isLoopbackOrUnspecified(host)

export type ForbiddenStore = { url: string; host: string; port: string; local: boolean }

// The forbidden stores from CHECKLIST_FORBIDDEN_STORE_URLS. Unset is
// refused (empty is none), and so is an entry that isn't an http or https
// URL, rather than skipped. `local` is read from the spelling only here;
// assertStoreTarget also marks an entry local when its host is this machine
// under another name.
export function parseForbiddenStores(raw: string | undefined): ForbiddenStore[] {
  if (raw === undefined) {
    return refuse(
      `${FORBIDDEN_STORES_ENV} is not set: list the stores the checklist must never reach, comma-separated, ` +
        `in .env.checklist (${FORBIDDEN_STORES_ENV}=http://localhost:9000), or set it empty to forbid none`
    )
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      let url: URL
      try {
        url = new URL(entry)
      } catch {
        return refuse(`${FORBIDDEN_STORES_ENV} holds ${JSON.stringify(entry)}, which isn't a URL`)
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        refuse(`${FORBIDDEN_STORES_ENV} holds ${JSON.stringify(entry)}, which isn't http or https`)
      }
      const host = normaliseHost(url.hostname)
      return { url: entry, host, port: portOf(url), local: isLocal(host) }
    })
}

const forbidden = (store: ForbiddenStore): never =>
  refuse(`STORE_URL is a store ${FORBIDDEN_STORES_ENV} forbids (${store.url}): refusing`)

const onPort = (url: URL, stores: ForbiddenStore[]) => stores.filter((f) => f.port === portOf(url))

function refuseByName(url: URL, stores: ForbiddenStore[]) {
  const host = normaliseHost(url.hostname)
  for (const f of onPort(url, stores)) {
    if ((f.local && isLocal(host)) || canonicalIp(host) === canonicalIp(f.host)) forbidden(f)
  }
}

// The checks that need no network: names and literal addresses.
export function assertStoreUrl(raw: string | undefined, stores: ForbiddenStore[] = []): URL {
  const url = parse(raw)
  refuseByName(url, stores)
  return url
}

// The full check. It first marks a forbidden entry on STORE_URL's port local
// when its host is this machine under another name: one of this machine's
// own addresses or its host name, or a name resolving to a loopback,
// unspecified or own address. Then it resolves STORE_URL's name and compares
// with this machine's own addresses and host name (for a local forbidden
// store) and with the forbidden host's addresses. A name that can't be
// resolved on a forbidden port is refused too (nothing should be guessed
// about it).
export async function assertStoreTarget(raw: string | undefined, stores: ForbiddenStore[] = [], deps: GuardDeps = {}): Promise<URL> {
  const url = parse(raw)
  const candidates = onPort(url, stores)
  if (!candidates.length) return url
  const host = normaliseHost(url.hostname)
  const own = normaliseHost((deps.hostname ?? osHostname)())
  const isOwnName = (name: string) => !!own && (name === own || name.split(".")[0] === own.split(".")[0])
  const ownAddresses = new Set((deps.localAddresses ?? defaultLocalAddresses)().map(canonicalIp))
  const isThisMachine = (address: string) => isLoopbackOrUnspecified(address) || ownAddresses.has(address)
  const lookup = deps.lookup ?? defaultLookup
  const resolve = async (name: string) => (isIP(name) ? [name] : await lookup(name)).map(canonicalIp)

  // New objects: the caller's list is left as parsed.
  const matching = await Promise.all(
    candidates.map(async (f) => {
      // A forbidden host that doesn't resolve is compared by name only.
      const theirs = f.local ? [] : await resolve(f.host).catch(() => [] as string[])
      return { ...f, local: f.local || isOwnName(f.host) || theirs.some(isThisMachine), theirs }
    })
  )
  refuseByName(url, matching)
  for (const f of matching) {
    if (f.local && isOwnName(host)) forbidden(f)
  }
  let addresses: string[]
  try {
    addresses = await resolve(host)
  } catch {
    return refuse(`STORE_URL's host doesn't resolve, so it can't be told apart from a store ${FORBIDDEN_STORES_ENV} forbids: refusing`)
  }
  for (const f of matching) {
    if (f.local && addresses.some(isThisMachine)) forbidden(f)
    if (addresses.some((a) => f.theirs.includes(a))) forbidden(f)
  }
  return url
}
