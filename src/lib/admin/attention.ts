import type { PrintTrailPluginOptions } from "../../config"
import type { AttentionRow } from "../admin-types"
import { printTrailAppUrl } from "../app-url"
import type { PrintTrailOrderRow } from "../send-flow"
import { canDismiss } from "./order-view"

// The "Needs attention" list. Reads the row's own order_id (older rows may
// have no link); an order that can't be loaded still lists, by id.
export function toAttentionRows(
  rows: (PrintTrailOrderRow & { updated_at?: Date | string | null; last_error?: string | null })[],
  displayIds: Map<string, number>,
  options: PrintTrailPluginOptions,
  teamCode: string | null
): AttentionRow[] {
  return rows.map((r) => ({
    id: r.id,
    order_id: r.order_id,
    display_id: displayIds.get(r.order_id) ?? null,
    pt_order_number: r.pt_order_number,
    pt_url: printTrailAppUrl(options, teamCode, r.pt_uuid),
    attention: r.attention ?? "",
    last_error: typeof r.last_error === "string" ? r.last_error : null,
    updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : "",
    dismissable: canDismiss(r.attention),
  }))
}
