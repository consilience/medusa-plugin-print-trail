// Pre-orders (Print Trail API 1.3.0). Skipped unless Print Trail reports
// 1.3.0 or its stock rows carry the pre-order fields.
import type { PtFulfilment } from "../../../src/modules/printTrail/client/types"
import { expect, skip, sleep, waitFor } from "../lib/runner"
import { firstRow, needsDispatch, needsPerson, placeAndConfirm, shipped, waitForRow, type Ctx, type Placed, type Scenario, type SkuRole, type T } from "./common"

const needs = (role: SkuRole, env: string) => (ctx: Ctx) =>
  !ctx.preOrder.supported
    ? ctx.preOrder.why
    : !ctx.config.skus[role]
      ? `${env} is not set`
      : !ctx.variants[role]
        ? `no variant resolves to ${env}`
        : null

const holds = (f: PtFulfilment, sku: string) =>
  (f.orderLines ?? []).some((l) => (l.product?.sku ?? "").toLowerCase() === sku.toLowerCase())

const waiting = (f: any) => f.status === "back-order" && (!("backOrderReason" in f) || f.backOrderReason === "pre-order")

async function preOrderPlaced(t: T): Promise<Placed> {
  const have = t.ctx.shared.get("pre-order")
  if (have) return have
  const placed = await placeAndConfirm(t, [{ role: "preOrderUnlimited", quantity: 1 }])
  t.ctx.shared.set("pre-order", placed)
  return placed
}

async function expectWaitingWithoutAttention(t: T, placed: Placed, sku: string) {
  const { ctx } = t
  await t.check("the pre-order fulfilment waits for release", async () => {
    const pt = await ctx.pt.order(placed.ref.uuid)
    const f = (pt.fulfilments ?? []).find((x) => holds(x, sku))
    expect(f, `no fulfilment holds ${sku}`)
    expect(waiting(f), `fulfilment ${f.status}, reason ${(f as any).backOrderReason ?? "none"}`)
    return `back-order, reason ${(f as any).backOrderReason ?? "(not sent)"}`
  })
  await t.check("no attention while waiting", async () => {
    await sleep(3000)
    const row = firstRow(await ctx.medusa.ptView(placed.orderId))
    expect(!row.attention, `attention ${row.attention}`)
    return "none"
  })
}

export const preOrderUnlimited: Scenario = {
  id: "preorder-unlimited",
  title: "Pre-order, no limit: purchasable at 0, confirmed, waiting without attention",
  needs: needs("preOrderUnlimited", "PT_PREORDER_SKU"),
  run: async (t) => {
    const { ctx } = t
    const v = ctx.variants.preOrderUnlimited!
    await t.check("Print Trail lists it as pre-order with no limit", async () => {
      const row = await ctx.pt.stockRow(v.sku)
      expect(row, `stock levels don't list ${v.sku}`)
      expect(row.status === "pre-order", `status ${row.status}`)
      expect(row.preOrderLimit == null && row.preOrderRemaining == null, `limit ${row.preOrderLimit}, remaining ${row.preOrderRemaining}`)
      return `stock ${row.stock}`
    })
    await t.check(
      "Medusa allows backorders on the variant",
      async () => {
        const view = await ctx.medusa.variantView(v.id)
        expect(view.stock?.allow_backorder, "allow_backorder is off: has the stock sync run since the product went on pre-order?")
        return view.stock?.pre_order === undefined ? "allow_backorder on" : `allow_backorder on, pre_order ${view.stock.pre_order}`
      },
      { soft: true }
    )
    const placed = await preOrderPlaced(t)
    await expectWaitingWithoutAttention(t, placed, v.sku)
  },
}

export const preOrderLimited: Scenario = {
  id: "preorder-limited",
  title: "Pre-order with a limit: stock is the remaining allowance",
  needs: needs("preOrderLimited", "PT_PREORDER_LIMITED_SKU"),
  run: async (t) => {
    const { ctx } = t
    const v = ctx.variants.preOrderLimited!
    let remaining = 0
    await t.check("Print Trail reports the limit and what's left", async () => {
      const row = await ctx.pt.stockRow(v.sku)
      expect(row, `stock levels don't list ${v.sku}`)
      expect(row.status === "pre-order", `status ${row.status}`)
      expect(typeof row.preOrderLimit === "number" && typeof row.preOrderRemaining === "number", `limit ${row.preOrderLimit}, remaining ${row.preOrderRemaining}`)
      expect(row.stock === row.preOrderRemaining, `stock ${row.stock} isn't the remaining ${row.preOrderRemaining}`)
      if (row.preOrderRemaining < 1) skip(`${v.sku} is sold out at Print Trail (0 of ${row.preOrderLimit} left)`)
      remaining = row.preOrderRemaining
      return `${remaining} of ${row.preOrderLimit} left`
    })
    await t.check(
      "Medusa's stock is the remaining allowance",
      async () => {
        if (ctx.mock) await ctx.mock.sendWebhook("stock-level-updated")
        await waitFor(
          "Medusa's stock",
          async () => {
            const levels = await ctx.medusa.stockLevels(v.id)
            return levels.length > 0 && levels.every((n) => n === remaining)
          },
          { timeoutMs: ctx.mock ? ctx.config.timeouts.webhook : 5000 }
        )
        return `${remaining} in Medusa`
      },
      { soft: true }
    )
    const placed = await placeAndConfirm(t, [{ role: "preOrderLimited", quantity: 1 }])
    await t.check("the allowance drops by the order", async () => {
      await waitFor("Print Trail's remaining allowance to drop", async () => (await ctx.pt.stockRow(v.sku))?.preOrderRemaining === remaining - 1, {
        timeoutMs: ctx.config.timeouts.send,
      })
      return `${remaining - 1} left`
    })
    await expectWaitingWithoutAttention(t, placed, v.sku)
  },
}

export const preOrderMixed: Scenario = {
  id: "preorder-mixed",
  title: "Mixed order: the in-stock parcel ships, the pre-order part waits",
  needs: (ctx) =>
    needsDispatch(ctx) ?? needs("preOrderUnlimited", "PT_PREORDER_SKU")(ctx) ?? (ctx.variants.stocked ? null : "no variant resolves to PT_STOCKED_SKU"),
  run: async (t) => {
    const { ctx } = t
    await needsPerson(t, "dispatch at Print Trail")
    const pre = ctx.variants.preOrderUnlimited!
    const placed = await placeAndConfirm(t, [
      { role: "stocked", quantity: 1 },
      { role: "preOrderUnlimited", quantity: 1 },
    ])
    let stockedIndex = -1
    await t.check("one waiting fulfilment, one going ahead", async () => {
      const fs = (await ctx.pt.order(placed.ref.uuid)).fulfilments ?? []
      stockedIndex = fs.findIndex((f) => !holds(f, pre.sku))
      const pending = fs.find((f) => holds(f, pre.sku))
      expect(stockedIndex >= 0 && pending, `${fs.length} fulfilment(s)`)
      expect(waiting(pending), `pre-order fulfilment is ${pending.status}`)
      return `${fs.length} fulfilments`
    })
    await t.check("the in-stock parcel dispatched", async () => {
      await ctx.driver.dispatch(placed.ref, stockedIndex)
      return `fulfilment ${stockedIndex + 1}`
    })
    await t.check("Medusa ships it and keeps the order open, with no attention", async () => {
      const order = await waitFor("one shipped fulfilment", async () => {
        const o = await ctx.medusa.order(placed.orderId)
        return shipped(o).length >= 1 ? o : null
      }, { timeoutMs: ctx.config.timeouts.webhook })
      expect(order.status !== "completed", "completed with the pre-order part still waiting")
      const row = firstRow(await ctx.medusa.ptView(placed.orderId))
      expect(!row.attention, `attention ${row.attention}`)
      return `${shipped(order).length} shipped, status ${order.status}`
    })
  },
}

// Opt-in (--include preorder-release): releasing makes the pre-order product
// active at Print Trail for good, so later runs have no pre-order SKU.
export const preOrderRelease: Scenario = {
  id: "preorder-release",
  title: "Release: the waiting fulfilment moves on and Medusa follows (opt-in: changes the product for good)",
  optIn: true,
  needs: needs("preOrderUnlimited", "PT_PREORDER_SKU"),
  run: async (t) => {
    const { ctx } = t
    await needsPerson(t, "release the pre-order product at Print Trail")
    const sku = ctx.variants.preOrderUnlimited!.sku
    const placed = await preOrderPlaced(t)
    await t.check("released at Print Trail", async () => {
      await ctx.driver.releasePreOrder(sku, placed.ref)
      await waitFor("the fulfilment to leave back-order", async () => {
        const fs = (await ctx.pt.order(placed.ref.uuid)).fulfilments ?? []
        return fs.every((f) => f.status !== "back-order")
      }, { timeoutMs: ctx.config.timeouts.webhook })
      return "released (this changes the product at Print Trail for good)"
    })
    await t.check("the plugin's row follows, with no attention", async () => {
      const pt = await ctx.pt.order(placed.ref.uuid)
      const { row } = await waitForRow(t, placed.orderId, `the row to show "${pt.status}"`, (r) => r.status === pt.status, ctx.config.timeouts.webhook)
      expect(!row.attention, `attention ${row.attention}`)
      return `row status ${row.status}`
    })
  },
}
