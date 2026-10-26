// Changes after the order is sent: cancel, edit, refund, resend, recovery.
import { HttpError, type Medusa } from "../lib/medusa"
import { ask, expect, fail, humanConfirm, manual, skip, waitFor } from "../lib/runner"
import { emailsFor, emailTemplate, firstRow, needsDispatch, needsPerson, placeAndConfirm, placeOrder, sharedOrder, waitForRow, type Scenario, type T } from "./common"

const CANCEL_FAILED = new Set(["refused", "too-late", "failed", "not-sent"])

const needsStocked = (ctx: { variants: { stocked: unknown } }) => (ctx.variants.stocked ? null : "no variant resolves to PT_STOCKED_SKU")

export const cancel: Scenario = {
  id: "cancel",
  title: "Cancel before dispatch",
  needs: needsStocked,
  run: async (t) => {
    const { ctx } = t
    const placed = await placeAndConfirm(t, [{ role: "stocked", quantity: 1 }])
    await t.check("Medusa cancels the order", async () => {
      await ctx.medusa.cancelOrder(placed.orderId)
      return "cancelled in Medusa"
    })
    await t.check("Print Trail cancels it", async () => {
      // requested: the plugin is still asking; awaiting: Print Trail took it (202).
      const { row } = await waitForRow(
        t,
        placed.orderId,
        "the plugin's cancel to finish",
        (r) => !!r.cancel_status && r.cancel_status !== "requested",
        ctx.config.timeouts.send
      )
      expect(!CANCEL_FAILED.has(row.cancel_status), `cancel ${row.cancel_status}${row.last_error ? `: ${row.last_error}` : ""}`)
      const pt = await ctx.pt.order(placed.ref.uuid)
      if (pt.status === "cancelled") return `cancelled at Print Trail (cancel ${row.cancel_status})`
      expect(row.cancel_status === "awaiting" || row.cancel_status === "cancelled", `cancel ${row.cancel_status}, Print Trail ${pt.status}`)
      expect(row.cancel_status === "awaiting", `the plugin says cancelled, Print Trail says ${pt.status}`)
      return `cancel accepted (202): Print Trail ${pt.status}, cancel awaiting`
    })
  },
}

export const cancelTooLate: Scenario = {
  id: "cancel-too-late",
  title: "Cancel too late: timeline note, attention and admin email",
  needs: (ctx) => needsDispatch(ctx) ?? needsStocked(ctx),
  run: async (t) => {
    const { ctx } = t
    await needsPerson(t, "dispatch at Print Trail")
    const placed = await placeAndConfirm(t, [{ role: "stocked", quantity: 1 }])
    await t.check("dispatched at Print Trail before Medusa hears", async () => {
      await ctx.driver.dispatchQuietly(placed.ref)
      return "dispatched"
    })
    await t.check("Medusa cancels the order", async () => {
      try {
        await ctx.medusa.cancelOrder(placed.orderId)
      } catch (e) {
        // Only Medusa's refusals over fulfilments (or the auto-completed
        // order they lead to) mean the webhook won the race.
        if (e instanceof HttpError && e.status < 500 && /fulfillments must be canceled|cannot cancel a completed order/i.test(String(e.body?.message ?? ""))) {
          skip(`Medusa refused the cancel (${e.status}): the dispatch webhook got there first, so this can't happen`)
        }
        throw e
      }
      return "cancelled in Medusa"
    })
    await t.check("the order is flagged cancel-too-late", async () => {
      const { row, view } = await waitForRow(
        t,
        placed.orderId,
        "the cancel-too-late flag",
        (r) => r.attention === "cancel-too-late",
        ctx.config.timeouts.send
      )
      expect((view.timeline ?? []).some((e: any) => e.kind === "cancel-too-late"), "no cancel-too-late timeline note")
      return `attention ${row.attention}, timeline note present`
    })
    await t.check(
      "one admin email per address",
      async () => {
        const template = emailTemplate(ctx, "cancelTooLate")
        if (!template) skip("the cancel-too-late email is off")
        const want = Number(ctx.connection?.options?.notifications?.adminEmailCount ?? 0)
        if (!want) skip("no notifications.adminEmail (PRINT_TRAIL_ADMIN_EMAIL) is set")
        const n = await waitFor(
          "the cancel-too-late notification(s)",
          async () => {
            const n = await emailsFor(ctx, template!, placed.orderId)
            return n >= want ? n : null
          },
          { timeoutMs: ctx.config.timeouts.webhook }
        )
        expect(n === want, `${n} emails for ${want} address(es)`)
        return `${n} notification(s), template ${template}`
      },
      { soft: true }
    )
    await t.check(
      "the admin email arrived",
      async () => {
        if (ctx.mock) skip("mock mode: the notification record is the check")
        if (!emailTemplate(ctx, "cancelTooLate") || !ctx.connection?.options?.notifications?.adminEmailCount) skip("no admin email is sent")
        const where = ctx.config.adminInboxNote ? ` (${ctx.config.adminInboxNote})` : ""
        return humanConfirm(ctx.config.interactive, `Did the cancel-too-late email for order #${placed.displayId} reach the admin inbox${where}?`)
      },
      { soft: true }
    )
  },
}

export const amend: Scenario = {
  id: "amend",
  title: "Order edit: Print Trail's lines are amended",
  needs: needsStocked,
  run: async (t) => {
    const { ctx } = t
    const placed = await placeAndConfirm(t, [{ role: "stocked", quantity: 1 }])
    let itemId = ""
    await t.check("order edit confirmed in Medusa (quantity 1 → 2)", async () => {
      const order = await ctx.medusa.order(placed.orderId)
      itemId = order.items[0].id
      await ctx.medusa.editItemQuantity(placed.orderId, itemId, 2)
      return `item ${itemId}`
    })
    await t.check("Print Trail's line follows", async () => {
      await waitFor(
        "Print Trail's quantity to change",
        async () => {
          const pt = await ctx.pt.order(placed.ref.uuid)
          return (pt.orderLines ?? []).find((l) => l.lineNumber === itemId)?.quantity === 2
        },
        { timeoutMs: ctx.config.timeouts.send }
      )
      return "quantity 2 at Print Trail"
    })
    await t.check(
      "no attention after the amend",
      async () => {
        const row = firstRow(await ctx.medusa.ptView(placed.orderId))
        expect(!row.attention, `attention ${row.attention}: ${row.last_error ?? ""}`)
        return "none"
      },
      { soft: true }
    )
  },
}

export const refund: Scenario = {
  id: "refund",
  title: "Refund: noted on the timeline, Print Trail unchanged",
  needs: needsStocked,
  run: async (t) => {
    const { ctx } = t
    const placed = await sharedOrder(t)
    await t.check("payment captured and partly refunded", async () => {
      const order = await ctx.medusa.order(placed.orderId)
      const payment = order.payment_collections?.[0]?.payments?.[0]
      expect(payment, "the order has no payment")
      if (!payment.captured_at) await ctx.medusa.capturePayment(payment.id)
      await ctx.medusa.refundPayment(payment.id, 1)
      return "refunded 1"
    })
    await t.check("the refund is on the timeline", async () => {
      await waitForRow(
        t,
        placed.orderId,
        "a refund timeline entry",
        (_r, view) => (view.timeline ?? []).some((e: any) => e.kind === "refund"),
        ctx.config.timeouts.webhook
      )
      return "noted"
    })
    await t.check("Print Trail isn't changed", async () => {
      const pt = await ctx.pt.order(placed.ref.uuid)
      expect(pt.status !== "cancelled", "Print Trail cancelled the order")
      const row = firstRow(await ctx.medusa.ptView(placed.orderId))
      expect(!row.block_reason, `block ${row.block_reason}`)
      return `status ${pt.status}`
    })
  },
}

export const resend: Scenario = {
  id: "resend",
  title: "Resend: refused when confirmed; as a new order after a Print Trail cancel",
  needs: needsStocked,
  run: async (t) => {
    const { ctx } = t
    const shared = await sharedOrder(t)
    await t.check("Resend of a confirmed order is refused", async () => {
      try {
        await ctx.medusa.resend(shared.orderId)
      } catch (e) {
        if (e instanceof HttpError && e.status === 409) {
          expect(e.body?.reason === "already-confirmed", `refused: ${e.body?.reason}`)
          return "refused: already-confirmed"
        }
        throw e
      }
      return fail("the resend went through on a confirmed order")
    })
    await needsPerson(t, "cancel at Print Trail")
    const placed = await placeAndConfirm(t, [{ role: "stocked", quantity: 1 }])
    await t.check("cancelled at Print Trail", async () => {
      await ctx.driver.cancelAtPrintTrail(placed.ref)
      await waitForRow(t, placed.orderId, "the row to show the cancel", (r) => r.status === "cancelled", ctx.config.timeouts.webhook)
      return "row cancelled"
    })
    await t.check("Resend as a new Print Trail order", async () => {
      const res = await resendWhenFree(ctx, placed.orderId, { as_new: true })
      expect(res.plan === "reissue", `plan ${res.plan}`)
      expect(res.outcome === "confirmed", `outcome ${res.outcome ?? "none"}${res.reason ? ` (${res.reason})` : ""}`)
      const view = await ctx.medusa.ptView(placed.orderId)
      const rows = [...view.rows].sort((a: any, b: any) => a.sequence - b.sequence)
      const fresh = rows[rows.length - 1]
      expect(rows.length === 2 && fresh.pt_uuid !== placed.ref.uuid, `${rows.length} row(s)`)
      const pt = await ctx.pt.order(fresh.pt_uuid)
      expect(pt.status !== "cancelled" && pt.status !== "draft", `new Print Trail order is ${pt.status}`)
      return `new Print Trail order ${fresh.pt_order_number}`
    })
  },
}

// The admin routes answer 409 "busy" while a run holds the order's lock.
async function resendWhenFree(ctx: { medusa: Medusa }, orderId: string, body: { as_new?: boolean } = {}) {
  return waitFor(
    "the order's lock to be free",
    async () => {
      try {
        return await ctx.medusa.resend(orderId, body)
      } catch (e) {
        if (e instanceof HttpError && e.status === 409 && e.body?.status === "busy") return null
        if (e instanceof HttpError && e.status === 409 && e.body?.reason === "already-confirmed") return e.body
        throw e
      }
    },
    { timeoutMs: 60_000 }
  )
}

async function countByNumber(ctx: { pt: { client: unknown } }, orderNumber: string): Promise<number> {
  // The plugin's client keeps its list call private; a count needs the list.
  const res = await (ctx.pt.client as any).call("GET", `/orders?order-number=${encodeURIComponent(orderNumber)}`)
  return ((res.body?.data ?? []) as any[]).filter((o) => o.orderNumber === orderNumber).length
}

// A pattern for the mock's failure list that can be switched off.
class Switch extends RegExp {
  armed = true
  test(s: string): boolean {
    return this.armed && super.test(s)
  }
}

async function crashOnMock(t: T, failConfirm: Switch) {
  const { ctx } = t
  let orderId = ""
  let row: any
  await t.check("order placed while confirm fails", async () => {
    const order = await placeOrder(ctx, [{ variantId: ctx.variants.stocked!.id, quantity: 1 }])
    orderId = order.id
    return `order #${order.displayId}`
  })
  await t.check("the draft is saved before confirm, with a retry pending", async () => {
    // last_error: the run has finished (the lease alone is set before the call).
    ;({ row } = await waitForRow(
      t,
      orderId,
      "a draft with a confirm retry",
      (r) => !!r.pt_uuid && r.pending_action === "confirm" && !!r.last_error,
      ctx.config.timeouts.send
    ))
    expect(!row.confirmed_at, "confirmed despite the failures")
    ctx.state.addPtUuid(orderId, row.pt_uuid)
    return `Print Trail order ${row.pt_order_number}, next attempt ${row.next_attempt_at}`
  })
  await t.check("retry confirms the same Print Trail order", async () => {
    failConfirm.armed = false
    // The sweep may have retried first: then Resend is refused as confirmed.
    const res = await resendWhenFree(ctx, orderId)
    expect(res.outcome === "confirmed" || res.reason === "already-confirmed", `outcome ${res.outcome ?? res.status}`)
    const after = firstRow(await ctx.medusa.ptView(orderId))
    expect(after.pt_uuid === row.pt_uuid, "a different Print Trail order")
    expect(after.confirmed_at, "not confirmed")
    const n = await countByNumber(ctx, row.pt_order_number)
    expect(n === 1, `${n} Print Trail orders numbered ${row.pt_order_number}`)
    return "one Print Trail order, confirmed"
  })
}

export const crash: Scenario = {
  id: "crash",
  title: "Crash safety: an interrupted send recovers without a duplicate",
  needs: needsStocked,
  run: async (t) => {
    const { ctx } = t
    if (ctx.mock) {
      // Every confirm attempt fails (the plugin's client tries four times), so
      // the run ends after the draft is saved: what a crash there leaves. The
      // switch disarms whatever is left of the failure when the scenario ends.
      const failConfirm = new Switch("/orders/[^/]+/confirm$")
      ctx.mock.fail(failConfirm, 503, { title: "Service Unavailable", status: 503 }, 4)
      try {
        await crashOnMock(t, failConfirm)
      } finally {
        failConfirm.armed = false
      }
      return
    }
    await needsPerson(t, "restart the store")
    const minutes = Math.round(ctx.config.timeouts.crash / 60000)
    await t.check("restart the store mid-send", async () => {
      const ready = await ask(
        `\n  >>> Crash safety: the script places an order, then asks you to restart the Medusa server and worker at once\n      (for example \`pm2 restart <server> <worker>\`). Confirming the order can then take up to ${minutes} min:\n      a send cut off by the restart is retried after its lease, on the next sweep. Ready? [y/s] `
      )
      if (!ready.trim().toLowerCase().startsWith("y")) manual("skipped by the tester")
      return "ready"
    })
    let orderId = ""
    await t.check("order placed, then the store restarted", async () => {
      const order = await placeOrder(ctx, [{ variantId: ctx.variants.stocked!.id, quantity: 1 }])
      orderId = order.id
      await ask(`\n  >>> Order #${order.displayId} placed. Restart the Medusa server and worker NOW, then press Enter. `)
      await waitFor("the store to answer again", () => ctx.medusa.health(), { timeoutMs: 300_000, intervalMs: 3000 })
      await ctx.medusa.login()
      return `order #${order.displayId}`
    })
    await t.check("sent and confirmed once after the restart", async () => {
      // An interrupted send keeps its lease's next attempt (the plugin's retry
      // delay), so the sweep only retries it after that.
      const { row } = await waitForRow(
        t,
        orderId,
        "the order to be confirmed (a send cut off by the restart is retried after its lease, by the sweep on PRINT_TRAIL_SWEEP_SCHEDULE)",
        (r) => !!r.confirmed_at,
        ctx.config.timeouts.crash
      )
      ctx.state.addPtUuid(orderId, row.pt_uuid)
      const n = await countByNumber(ctx, row.pt_order_number)
      expect(n === 1, `${n} Print Trail orders numbered ${row.pt_order_number}`)
      return `one Print Trail order ${row.pt_order_number}`
    })
  },
}
