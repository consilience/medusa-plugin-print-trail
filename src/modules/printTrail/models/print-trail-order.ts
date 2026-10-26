import { model } from "@medusajs/framework/utils"

// One row per Print Trail order. A Medusa order can have several (claims,
// exchanges and released pre-orders are sent as "-n" orders).
const PrintTrailOrder = model
  .define("print_trail_order", {
    id: model.id({ prefix: "ptord" }).primaryKey(),
    // Duplicates the module link so the sweep and the lock need no graph query.
    order_id: model.text().index(),
    sequence: model.number().default(1),
    pt_order_number: model.text(),
    pt_uuid: model.text().index().nullable(),
    print_trail_order_number: model.text().nullable(),
    status: model.text().nullable(),
    fulfillable_status: model.text().nullable(),
    fulfilments: model.json().nullable(),
    errors: model.json().nullable(),
    submitted_lines: model.json().nullable(),
    block_reason: model.text().nullable(),
    shortfall: model.json().nullable(),
    attention: model.text().nullable(),
    // The attention keys an admin dismissed (pt-returned, pt-partial, or a
    // returned or failed fulfilment, or one held on an inactive pre-order
    // product, by number), as `{pt_uuid}|{key},{key}`:
    // the sync passes them over and forgets each once Print Trail no longer
    // reports it (src/lib/sync-decisions.ts). Text, not JSON: service updates
    // merge JSON objects.
    dismissed_attention: model.text().nullable(),
    // Set locally when Print Trail accepts a confirm. Print Trail's own status
    // can't tell (holding occurs before and after confirmation).
    confirmed_at: model.dateTime().nullable(),
    pending_action: model.enum(["send", "confirm", "cancel", "amend", "refetch"]).nullable(),
    attempts: model.json().default({}),
    next_attempt_at: model.dateTime().index().nullable(),
    last_error: model.text().nullable(),
    cancel_requested: model.boolean().default(false),
    last_synced_at: model.dateTime().nullable(),
    // What the row carries: null for the order itself, else claim:{id},
    // exchange:{id}, remainder:{sequence} or reissue:{sequence}.
    source_ref: model.text().nullable(),
    // The Medusa cancel's progress at Print Trail. Written only by the cancel
    // flow and the sync settlement, never by the send path.
    cancel_status: model
      .enum(["requested", "awaiting", "cancelled", "too-late", "refused", "failed", "not-sent"])
      .index()
      .nullable(),
    // When the "cancel too late" note (and admin email) went out: once per row.
    cancel_notified_at: model.dateTime().nullable(),
    // Fingerprint of the delivery address last posted.
    address_hash: model.text().nullable(),
    // Lines filterLines held back: [{ lineItemId, quantity }].
    held_lines: model.json().nullable(),
    // The Print Trail fulfilments ever seen waiting for their pre-order
    // release (uuids, add-only), so the parcel's shipment email can say so
    // once it dispatches (backOrderReason is null by then).
    pre_order_fulfilments: model.json().nullable(),
  })
  .indexes([
    { on: ["order_id", "sequence"], unique: true },
    { on: ["order_id", "source_ref"], unique: true, where: "source_ref IS NOT NULL" },
  ])

export default PrintTrailOrder
