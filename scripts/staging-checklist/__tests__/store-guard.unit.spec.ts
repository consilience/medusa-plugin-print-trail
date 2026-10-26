import {
  assertStoreTarget,
  assertStoreUrl,
  canonicalIp,
  isLoopbackOrUnspecified,
  parseForbiddenStores,
} from "../lib/store-guard"

// Made-up stores: one on a local port, one remote.
const LOCAL = parseForbiddenStores("http://localhost:9300")
const REMOTE = parseForbiddenStores("https://live-shop.example.net")
const FORBIDS = /CHECKLIST_FORBIDDEN_STORE_URLS forbids/

const deps = (addresses: Record<string, string[]> = {}, local: string[] = ["192.168.1.20", "fe80::1"]) => ({
  lookup: async (host: string) => {
    if (!(host in addresses)) throw new Error("ENOTFOUND")
    return addresses[host]
  },
  localAddresses: () => ["127.0.0.1", "::1", ...local],
  hostname: () => "dev-box.local",
})

describe("store guard: a forbidden local store", () => {
  it.each([
    "http://localhost:9300",
    "http://localhost.:9300",
    "http://foo.localhost.:9300",
    "http://LOCALHOST:9300",
    "http://127.0.0.1:9300",
    "http://127.1:9300",
    "http://2130706433:9300",
    "http://[::1]:9300",
    "http://[0:0:0:0:0:0:0:1]:9300",
    "http://[::ffff:127.0.0.1]:9300",
    "http://[::]:9300",
    "http://0.0.0.0:9300",
  ])("refuses %s without a lookup", (url) => {
    expect(() => assertStoreUrl(url, LOCAL)).toThrow(FORBIDS)
  })

  it("refuses names that resolve to loopback (lvh.me, nip.io)", async () => {
    const d = deps({ "lvh.me": ["127.0.0.1"], "127.0.0.1.nip.io": ["127.0.0.1"], "v6.example": ["::1"] })
    for (const url of ["http://lvh.me:9300", "http://127.0.0.1.nip.io:9300", "http://v6.example:9300"]) {
      await expect(assertStoreTarget(url, LOCAL, d)).rejects.toThrow(FORBIDS)
    }
  })

  it("refuses this machine's LAN address and host name", async () => {
    const d = deps({ "box.lan": ["192.168.1.20"] })
    await expect(assertStoreTarget("http://192.168.1.20:9300", LOCAL, d)).rejects.toThrow(FORBIDS)
    await expect(assertStoreTarget("http://box.lan:9300", LOCAL, d)).rejects.toThrow(FORBIDS)
    await expect(assertStoreTarget("http://dev-box.local:9300", LOCAL, d)).rejects.toThrow(FORBIDS)
    await expect(assertStoreTarget("http://dev-box:9300", LOCAL, d)).rejects.toThrow(FORBIDS)
  })

  it("refuses an unresolvable host on the forbidden port", async () => {
    await expect(assertStoreTarget("http://nowhere.invalid:9300", LOCAL, deps())).rejects.toThrow(/doesn't resolve/)
  })

  it("allows other ports and remote hosts on the forbidden port", async () => {
    const d = deps({ "store.example.com": ["203.0.113.5"] })
    expect((await assertStoreTarget("http://localhost:9100", LOCAL, d)).port).toBe("9100")
    expect((await assertStoreTarget("http://store.example.com:9300", LOCAL, d)).hostname).toBe("store.example.com")
    expect((await assertStoreTarget("https://store.example.com", LOCAL, d)).hostname).toBe("store.example.com")
  })
})

describe("store guard: a forbidden store on this machine under another name", () => {
  // Every local spelling on the forbidden port: the deps' LAN address and host name too.
  const LOCAL_HOSTS = [
    "http://localhost:9300",
    "http://127.0.0.1:9300",
    "http://127.0.0.2:9300",
    "http://[::1]:9300",
    "http://0.0.0.0:9300",
    "http://192.168.1.20:9300",
    "http://dev-box.local:9300",
    "http://dev-box:9300",
  ]

  it("refuses every local host on its port when its name resolves to loopback", async () => {
    const stores = parseForbiddenStores("http://shop.lan:9300")
    const d = deps({ "shop.lan": ["127.0.0.1"], "store.example.com": ["203.0.113.5"] })
    for (const url of ["http://shop.lan:9300", ...LOCAL_HOSTS]) {
      await expect(assertStoreTarget(url, stores, d)).rejects.toThrow(FORBIDS)
    }
    expect((await assertStoreTarget("http://localhost:9100", stores, d)).port).toBe("9100")
    expect((await assertStoreTarget("http://store.example.com:9300", stores, d)).hostname).toBe("store.example.com")
    // Parsing reads the spelling only, and the guard leaves the list as parsed.
    expect(stores[0].local).toBe(false)
  })

  it("refuses every local host on its port when it is this machine's own address", async () => {
    const stores = parseForbiddenStores("http://192.168.1.20:9300")
    for (const url of LOCAL_HOSTS) {
      await expect(assertStoreTarget(url, stores, deps())).rejects.toThrow(FORBIDS)
    }
    expect((await assertStoreTarget("http://localhost:9100", stores, deps())).port).toBe("9100")
  })

  it("refuses every local host on its port when it is this machine's host name", async () => {
    for (const entry of ["http://dev-box.local:9300", "http://DEV-BOX:9300"]) {
      const stores = parseForbiddenStores(entry)
      for (const url of LOCAL_HOSTS) {
        await expect(assertStoreTarget(url, stores, deps())).rejects.toThrow(FORBIDS)
      }
      expect((await assertStoreTarget("http://localhost:9100", stores, deps())).port).toBe("9100")
    }
  })
})

describe("store guard: a forbidden remote store", () => {
  it("refuses its name however it is written, on its port", () => {
    for (const url of ["https://live-shop.example.net", "https://LIVE-SHOP.example.net.", "https://live-shop.example.net:443/app"]) {
      expect(() => assertStoreUrl(url, REMOTE)).toThrow(FORBIDS)
    }
    expect(assertStoreUrl("http://live-shop.example.net", REMOTE).protocol).toBe("http:")
  })

  it("refuses another name for the same address", async () => {
    const d = deps({ "live-shop.example.net": ["203.0.113.9"], "alias.example.org": ["203.0.113.9"], "other.example.org": ["203.0.113.10"] })
    await expect(assertStoreTarget("https://alias.example.org", REMOTE, d)).rejects.toThrow(FORBIDS)
    await expect(assertStoreTarget("https://203.0.113.9", REMOTE, d)).rejects.toThrow(FORBIDS)
    expect((await assertStoreTarget("https://other.example.org", REMOTE, d)).hostname).toBe("other.example.org")
  })

  it("leaves local stores on other ports alone", async () => {
    expect((await assertStoreTarget("http://localhost:9300", REMOTE, deps({}))).hostname).toBe("localhost")
  })

  it("stays remote when it resolves elsewhere, or not at all (then it is compared by name)", async () => {
    const elsewhere = deps({ localhost: ["127.0.0.1"], "live-shop.example.net": ["203.0.113.9"] })
    expect((await assertStoreTarget("https://localhost", REMOTE, elsewhere)).hostname).toBe("localhost")
    const nowhere = deps({ localhost: ["127.0.0.1"], "alias.example.org": ["203.0.113.9"] })
    expect((await assertStoreTarget("https://localhost", REMOTE, nowhere)).hostname).toBe("localhost")
    expect((await assertStoreTarget("https://alias.example.org", REMOTE, nowhere)).hostname).toBe("alias.example.org")
    await expect(assertStoreTarget("https://live-shop.example.net", REMOTE, nowhere)).rejects.toThrow(FORBIDS)
  })
})

describe("store guard", () => {
  it("allows any store when none is forbidden", async () => {
    expect((await assertStoreTarget("http://localhost:9300", [], deps())).port).toBe("9300")
    expect(assertStoreUrl("http://127.0.0.1:9300").port).toBe("9300")
  })

  it("reads a comma-separated list and refuses an entry that isn't a URL", () => {
    expect(parseForbiddenStores(" http://localhost:9300 , https://live-shop.example.net ,")).toEqual([
      { url: "http://localhost:9300", host: "localhost", port: "9300", local: true },
      { url: "https://live-shop.example.net", host: "live-shop.example.net", port: "443", local: false },
    ])
    expect(() => parseForbiddenStores(undefined)).toThrow(/CHECKLIST_FORBIDDEN_STORE_URLS is not set/)
    expect(parseForbiddenStores("")).toEqual([])
    expect(() => parseForbiddenStores("localhost:9300")).toThrow(/isn't http or https/)
    expect(() => parseForbiddenStores("not a url")).toThrow(/isn't a URL/)
  })

  it("refuses credentials in the URL", () => {
    expect(() => assertStoreUrl("http://user:pw@store.example.com")).toThrow(/user name or password/)
  })

  it("normalises IPv6", () => {
    expect(canonicalIp("[::ffff:7f00:1]")).toBe("127.0.0.1")
    expect(canonicalIp("::FFFF:192.168.1.20")).toBe("192.168.1.20")
    expect(isLoopbackOrUnspecified("::")).toBe(true)
    expect(isLoopbackOrUnspecified("::2")).toBe(false)
    expect(isLoopbackOrUnspecified("10.0.0.1")).toBe(false)
  })
})
