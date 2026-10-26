// The staging smoke may only reach Print Trail staging: https, a host under
// consilstaging.com, and never a printtrail.com host.
export function assertStagingTarget(baseUrl: string | undefined): URL {
  const refuse = (why: string): never => {
    // eslint-disable-next-line @medusajs/use-medusa-error-not-generic-error
    throw new Error(`staging smoke: refusing ${JSON.stringify(baseUrl ?? null)}: ${why}`)
  }
  if (!baseUrl) return refuse("PT_STAGING_BASE_URL is not set")
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return refuse("not a URL")
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "")
  if (url.protocol !== "https:") refuse("staging must be https")
  if (host === "printtrail.com" || host.endsWith(".printtrail.com")) refuse("that is a Print Trail production host")
  if (host !== "consilstaging.com" && !host.endsWith(".consilstaging.com")) refuse("not a consilstaging.com host")
  return url
}
