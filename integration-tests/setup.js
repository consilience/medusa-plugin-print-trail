const { MetadataStorage } = require("@medusajs/framework/mikro-orm/core")

MetadataStorage.clear()

// No test may reach the production Print Trail API. The plugin defaults to it
// when no base URL is set, so a request from a test that forgets one is
// refused here, before it leaves the machine (the client may retry it, and
// its caller may carry on). Everything else goes to the real fetch.
const PRODUCTION_HOSTNAME = "api.printtrail.com"
const realFetch = globalThis.fetch
const hostnameOf = (href) => {
  try {
    return new URL(String(href)).hostname.toLowerCase().replace(/\.$/, "")
  } catch {
    return null
  }
}
globalThis.fetch = function refuseProductionFetch(input, init) {
  // fetch reads a Request's url and turns anything else (a URL included)
  // into a string, so both are checked.
  if ([input?.url, input].some((href) => hostnameOf(href) === PRODUCTION_HOSTNAME)) {
    return Promise.reject(new Error(`test setup: refusing a request to the production Print Trail API (${PRODUCTION_HOSTNAME}); set a base URL`))
  }
  return realFetch(input, init)
}
