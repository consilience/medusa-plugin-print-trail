// Sending, webhooks and dispatch.
import { itemQuantity } from "../lib/medusa"
import { dispatched } from "../lib/print-trail"
import { expect, humanConfirm, manual, skip, sleep, waitFor } from "../lib/runner"
import {
  emailsFor,
  emailTemplate,
  liveFulfilments,
  needsPerson,
  placeAndConfirm,
  sharedOrder,
  shipped,
  trackingNumbers,
  waitForRow,
  type Ctx,
  type Placed,
  type Scenario,
  type T,
} from "./common"

export const send: Scenario = {
  id: "send",
  title: "Place an order: sent, confirmed and linked",
  needs: (ctx) => (ctx.variants.stocked ? null : "no variant resolves to PT_STOCKED_SKU"),
  run: async (t) => {
    const { ctx } = t
    const placed = await sharedOrder(t)
    await t.check("the Medusa order links to the Print Trail order", async () => {
      expect(placed.row.pt_url, "no link (pt_url): the plugin doesn't know the team code yet")
      return placed.row.pt_url
    })
    await t.check("Print Trail holds the order as sent", async () => {
      const pt = await ctx.pt.order(placed.ref.uuid)
      expect(pt.orderNumber === placed.row.pt_order_number, `Print Trail number ${pt.orderNumber}`)
      expect(pt.status !== "draft", "still a draft at Print Trail")
      const order = await ctx.medusa.order(placed.orderId)
      for (const item of order.items ?? []) {
        const line = (pt.orderLines ?? []).find((l) => l.lineNumber === item.id)
        expect(line, `no Print Trail line for item ${item.id}`)
        expect(line.quantity === itemQuantity(item), `item ${item.id}: Medusa ${itemQuantity(item)}, Print Trail ${line.quantity}`)
      }
      return `status ${pt.status}, ${pt.orderLines?.length ?? 0} line(s)`
    })
    await t.check(
      "Print Trail reports when it was confirmed",
      async () => {
        const pt = (await ctx.pt.order(placed.ref.uuid)) as any
        if (!("confirmedAt" in pt)) skip("no confirmedAt (a Print Trail API before 1.1.0)")
        expect(pt.confirmedAt, "confirmedAt is null on a confirmed order")
        return pt.confirmedAt
      },
      { soft: true }
    )
    await t.check(
      "no attention",
      async () => {
        expect(!placed.row.attention, `attention ${placed.row.attention}`)
        return "none"
      },
      { soft: true }
    )
  },
}

export const webhook: Scenario = {
  id: "webhook",
  title: "Webhook delivery: a status change at Print Trail reaches Medusa",
  needs: (ctx) => (ctx.variants.stocked ? null : "no variant resolves to PT_STOCKED_SKU"),
  run: async (t) => {
    const { ctx } = t
    await needsPerson(t, "change the order's status at Print Trail")
    const placed = await sharedOrder(t)
    const before = (await ctx.pt.order(placed.ref.uuid)).status
    await t.check("status changed at Print Trail", async () => {
      await ctx.driver.changeStatus(placed.ref, before)
      return `${before} → ${(await ctx.pt.order(placed.ref.uuid)).status}`
    })
    await t.check("the plugin's row follows", async () => {
      const after = (await ctx.pt.order(placed.ref.uuid)).status
      const { row } = await waitForRow(t, placed.orderId, `the row to show "${after}"`, (r) => r.status === after, ctx.config.timeouts.webhook)
      return `row status ${row.status}`
    })
  },
}

// Dispatch at Print Trail, then wait for one Medusa fulfilment and shipment
// per dispatched parcel.
async function expectShipments(t: T, placed: Placed, parcels: number) {
  const { ctx } = t
  await t.check(`${parcels} Medusa fulfilment(s) with a shipment and tracking`, async () => {
    expect(parcels > 0, "no dispatched Print Trail fulfilment to compare with")
    const order = await waitFor(
      `${parcels} shipped fulfilment(s)`,
      async () => {
        const o = await ctx.medusa.order(placed.orderId)
        return shipped(o).length >= parcels ? o : null
      },
      { timeoutMs: ctx.config.timeouts.webhook }
    )
    expect(liveFulfilments(order).length === parcels, `${liveFulfilments(order).length} fulfilments for ${parcels} parcel(s)`)
    const pt = await ctx.pt.order(placed.ref.uuid)
    const medusaNumbers = new Set(shipped(order).flatMap((f: any) => f.labels.map((l: any) => l.tracking_number)))
    const untracked = (pt.fulfilments ?? []).filter((f) => f.status === "dispatched" && !(f.trackingDetails ?? []).some((d) => d.trackingNumber ?? d.number))
    expect(untracked.length === 0, `${untracked.length} dispatched Print Trail fulfilment(s) have no tracking number`)
    const missing = trackingNumbers(pt).filter((n) => !medusaNumbers.has(n))
    expect(missing.length === 0, `tracking numbers not in Medusa: ${missing.join(", ")}`)
    return `${parcels} shipped, tracking ${[...medusaNumbers].join(", ")}`
  })
}

async function expectCompleted(t: T, placed: Placed) {
  const { ctx } = t
  await t.check(
    "the order auto-completes",
    async () => {
      if (ctx.connection?.options?.autoComplete === false) skip("autoComplete is off")
      await waitFor("the Medusa order to complete", async () => (await ctx.medusa.order(placed.orderId)).status === "completed", {
        timeoutMs: ctx.config.timeouts.webhook,
      })
      return "completed"
    },
    { soft: true }
  )
}

async function expectShipmentEmails(t: T, placed: Placed, parcels: number) {
  const { ctx } = t
  await t.check(
    `${parcels} shipment email(s) sent`,
    async () => {
      const template = emailTemplate(ctx, "shipment")
      if (!template) skip("the shipment email is off (notifications.shipment: false)")
      const n = await waitFor(
        "the shipment notification(s)",
        async () => {
          const n = await emailsFor(ctx, template!, placed.orderId)
          return n >= parcels ? n : null
        },
        { timeoutMs: ctx.config.timeouts.webhook }
      )
      expect(n === parcels, `${n} emails for ${parcels} parcel(s)`)
      return `${n} notification(s), template ${template}`
    },
    { soft: true }
  )
  await t.check(
    "the shipment email arrived",
    async () => {
      if (ctx.mock) skip("mock mode: the notification record is the check")
      if (!emailTemplate(ctx, "shipment")) skip("the shipment email is off")
      if (/@example\.com$/i.test(ctx.config.customerEmail)) manual("the customer address is @example.com: set CHECKLIST_CUSTOMER_EMAIL to an inbox you can read")
      return humanConfirm(ctx.config.interactive, `Did ${parcels} shipment email(s) for order #${placed.displayId} reach the CHECKLIST_CUSTOMER_EMAIL inbox?`)
    },
    { soft: true }
  )
}

export const dispatch: Scenario = {
  id: "dispatch",
  title: "Dispatch: Medusa fulfilment, shipment, tracking and auto-complete",
  needs: (ctx) => (ctx.variants.stocked ? null : "no variant resolves to PT_STOCKED_SKU"),
  run: async (t) => {
    const { ctx } = t
    await needsPerson(t, "dispatch at Print Trail")
    const placed = await placeAndConfirm(t, [{ role: "stocked", quantity: 1 }])
    let parcels = 0
    await t.check("dispatched at Print Trail", async () => {
      await ctx.driver.dispatch(placed.ref)
      const pt = await ctx.pt.order(placed.ref.uuid)
      parcels = (pt.fulfilments ?? []).filter((f) => f.status === "dispatched").length
      expect(parcels > 0, `no fulfilment dispatched (status ${pt.status})`)
      return `${parcels} parcel(s), status ${pt.status}`
    })
    await expectShipments(t, placed, parcels)
    await expectCompleted(t, placed)
    await expectShipmentEmails(t, placed, parcels)
  },
}

export const twoParcel: Scenario = {
  id: "two-parcel",
  title: "Two-parcel order: one fulfilment and shipment per parcel",
  needs: (ctx: Ctx) =>
    !ctx.config.skus.second
      ? "PT_SECOND_SKU is not set"
      : !ctx.variants.second
        ? "no variant resolves to PT_SECOND_SKU"
        : !ctx.variants.stocked
          ? "no variant resolves to PT_STOCKED_SKU"
          : null,
  run: async (t) => {
    const { ctx } = t
    await needsPerson(t, "dispatch at Print Trail")
    const placed = await placeAndConfirm(t, [
      { role: "stocked", quantity: 1 },
      { role: "second", quantity: 1 },
    ])
    await t.check("Print Trail splits it into two fulfilments", async () => {
      const pt = await ctx.pt.order(placed.ref.uuid)
      const n = pt.fulfilments?.length ?? 0
      if (n < 2) skip("Print Trail put both SKUs in one fulfilment: pick PT_SECOND_SKU from another supplier location")
      return `${n} fulfilments`
    })
    await t.check("first parcel dispatched at Print Trail", async () => {
      await ctx.driver.dispatch(placed.ref, 0)
      return "fulfilment 1"
    })
    await expectShipments(t, placed, 1)
    await t.check("the order stays open with a parcel to go", async () => {
      await sleep(3000)
      const order = await ctx.medusa.order(placed.orderId)
      expect(order.status !== "completed", "completed with a parcel still undispatched")
      return `status ${order.status}`
    })
    await t.check("the rest dispatched at Print Trail", async () => {
      await ctx.driver.dispatch(placed.ref)
      expect(dispatched(await ctx.pt.order(placed.ref.uuid)), "not every fulfilment is dispatched")
      return "all fulfilments"
    })
    const parcels = (await ctx.pt.order(placed.ref.uuid)).fulfilments?.filter((f) => f.status === "dispatched").length ?? 0
    await expectShipments(t, placed, parcels)
    await expectCompleted(t, placed)
    await expectShipmentEmails(t, placed, parcels)
  },
}
