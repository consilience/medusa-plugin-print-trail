import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { amendRows } from "../../lib/amend-flow"
import { printTrailAppUrl } from "../../lib/app-url"
import type { GraphOrder, ScopedLine, SelectedLine } from "../../lib/lines"
import { printTrailOrderNumber } from "../../lib/order-number"
import { unservedPrintTrailItems } from "../../lib/order-scope"
import type { PrintTrailEvent, PrintTrailOrderRow } from "../../lib/send-flow"
import { buildCancelContext } from "./cancel-context"
import { buildSendContext } from "./send-context"
import { loadPtProfileIds } from "./stock-context"

// The key to record when unserved items need a (new) attention entry, else
// null: the same set of items is flagged once.
export function unservedAttentionDue(itemIds: string[], recordedKeys: string[]): string | null {
  if (!itemIds.length) return null
  const key = [...itemIds].sort().join(",")
  return recordedKeys.includes(key) ? null : key
}

// A filterLines handler returns lines; their claim/exchange source is taken
// back from the loaded lines, so a rebuilt object can't make a claim item
// look like the order's own.
export function reattachSources(result: SelectedLine[] | undefined, all: ScopedLine[]): ScopedLine[] {
  if (!result) return all
  const source = new Map(all.map((l) => [l.lineItemId, l.replacementOf]))
  return result.map((l) => ({ ...l, replacementOf: source.get(l.lineItemId) ?? null }))
}

const ATTENTION = "no-pt-shipping-method"

export const amendPrintTrailRowsStep = createStep(
  "amend-print-trail-rows",
  async (input: { order: GraphOrder; lines: ScopedLine[]; leased?: string[] }, { container }) => {
    const { order } = input
    const ctx = await buildCancelContext(container, order.id)
    const rows = ((await ctx.store.listPrintTrailOrders({ order_id: order.id })) as PrintTrailOrderRow[]).sort(
      (a, b) => a.sequence - b.sequence
    )
    const canceled = !!order.canceled_at || order.status === "canceled"
    // A line filterLines dropped keeps what was sent; only a removed item
    // (quantity 0, or gone) is zeroed.
    const itemQuantities = new Map(
      (order.items ?? []).flatMap((i) => (i ? [[i.id, Number(i.detail?.quantity ?? 0)] as [string, number]] : []))
    )
    const { outcomes, resend, remainder } = await amendRows(ctx, order.id, input.lines, canceled, itemQuantities, { leased: input.leased })

    // Print Trail items no Print Trail shipping method serves are never sent.
    const events: PrintTrailEvent[] = []
    if (!canceled) {
      const query = container.resolve(ContainerRegistrationKeys.QUERY)
      const unserved = unservedPrintTrailItems(order, await loadPtProfileIds(query))
      const first = rows[0]
      const recorded = first
        ? (await ctx.store.listPrintTrailOrderEvents({ print_trail_order_id: first.id, kind: ATTENTION })).map((e) => String(e.data?.key))
        : []
      const key = unservedAttentionDue(unserved, recorded)
      if (key) {
        let row = first
        if (!row) {
          // No row at all: one with no uuid, so the attention list shows it.
          const send = await buildSendContext(container)
          row = await send.store.createPrintTrailOrders({
            order_id: order.id,
            sequence: 1,
            pt_order_number: printTrailOrderNumber(ctx.options.orderNumberPrefix, order.display_id, 1),
            block_reason: ATTENTION,
            attention: ATTENTION,
          })
        } else if (row.attention !== ATTENTION) {
          await ctx.store.updatePrintTrailOrders({ id: row.id, attention: ATTENTION })
        }
        await ctx.store.createPrintTrailOrderEvents([
          {
            order_id: order.id,
            print_trail_order_id: row.id,
            kind: ATTENTION,
            message: `These items are in a Print Trail shipping profile but the order has no Print Trail shipping method, so they won't be sent: ${unserved.join(", ")}`,
            data: { key, item_ids: unserved, pt_uuid: row.pt_uuid ?? null, pt_url: printTrailAppUrl(ctx.options, ctx.teamCode, row.pt_uuid) },
          },
        ])
        events.push({
          name: "print_trail.order.attention",
          data: { order_id: order.id, print_trail_order_id: row.id, pt_uuid: row.pt_uuid ?? null, attention: ATTENTION },
        })
      }
    }
    return new StepResponse({ outcomes, resend, remainder, events })
  }
)
