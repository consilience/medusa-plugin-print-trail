import type { PrintTrailPluginOptions } from "../config"

export type AppUrlOptions = Pick<PrintTrailPluginOptions, "appUrl" | "baseUrl">

// The Print Trail app's base URL: the appUrl option, or the API host with
// api. turned into app. (production), or the API host itself (staging serves
// the app from the same host).
export function printTrailAppBase(o: AppUrlOptions): string | null {
  if (o.appUrl) {
    return o.appUrl
  }
  if (!o.baseUrl) {
    return null
  }
  return o.baseUrl.replace(/^(https?:\/\/)api\./i, "$1app.")
}

// {appBase}/{teamCode}/{path}: a page of the team's Print Trail app.
export function printTrailAppPath(o: AppUrlOptions, teamCode: string | null | undefined, path: string): string | null {
  const base = printTrailAppBase(o)
  if (!base || !teamCode) {
    return null
  }
  return `${base}/${encodeURIComponent(teamCode)}/${path}`
}

// {appBase}/{teamCode}/orders/{pt_uuid}: the order's page in the Print Trail app.
export function printTrailAppUrl(
  o: AppUrlOptions,
  teamCode: string | null | undefined,
  ptUuid: string | null | undefined
): string | null {
  return ptUuid ? printTrailAppPath(o, teamCode, `orders/${ptUuid}`) : null
}
