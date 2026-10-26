// The connection, the API version and stock: nothing here places an order.
import { versionAtLeast } from "../lib/config"
import { sameMetadata } from "../lib/medusa"
import { expect, fail, manual, skip, sleep, waitFor } from "../lib/runner"
import type { Scenario } from "./common"

const SERIOUS_WARNINGS = new Set(["not-configured", "no-webhook-secret", "no-backend-url"])

export const connection: Scenario = {
  id: "connection",
  title: "Connection and webhook registration",
  run: async (t) => {
    const { ctx } = t
    let tested: any
    await t.check("Test connection succeeds", async () => {
      tested = await ctx.medusa.testConnection()
      // The mock's store is local, so the plugin asks before registering it.
      if (ctx.mock && tested.webhook?.action === "needs-confirmation") {
        const forced = await ctx.medusa.registerWebhook(true)
        tested = { ...tested, webhook: { ...forced, action: forced.action ?? forced.webhook?.action } }
      }
      const d = tested.diagnosis
      expect(d?.ok, `diagnosis ${d?.code ?? "unknown"}${d?.detail ? `: ${d.detail}` : ""}`)
      return `team ${d.teamCode}, channel ${d.channelCode}`
    })
    let view: any
    await t.check("webhook registered at the store's backend URL", async () => {
      const action = tested.webhook?.action
      expect(
        action === "registered" || action === "already-registered",
        `webhook action ${action}${action === "needs-confirmation" ? " (the backend URL isn't https or is local: confirm it on Settings → Print Trail)" : ""}${tested.webhook?.detail ? `: ${tested.webhook.detail}` : ""}`
      )
      view = await ctx.medusa.connection()
      ctx.connection = view
      expect(view.webhook?.state === "registered", `webhook state ${view.webhook?.state}`)
      return `${action}, ${view.webhook.targetUrl}`
    })
    if (ctx.mock) {
      await t.check("the mock received the registration", async () => {
        expect(ctx.mock!.state.webhookUrl === view.webhook.targetUrl, "the mock holds a different webhook URL")
        return ctx.mock!.state.webhookUrl!
      })
    }
    await t.check("webhook secret in place", async () => {
      const secret = view.credentials?.webhookSecret ?? {}
      // Detected per field: a stored secret is from Print Trail whatever the
      // version says. The version only tightens what's expected.
      expect(secret.set, "no webhook secret: press Test connection, or set PRINT_TRAIL_WEBHOOK_SECRET")
      if (secret.source === "print-trail") return "returned by Print Trail on register and stored"
      if (!("source" in secret)) return "configured (this plugin build doesn't store the secret Print Trail returns)"
      if (versionAtLeast(ctx.pt.apiVersion, "1.1.0")) {
        fail(`source ${secret.source}: Print Trail ${ctx.pt.apiVersion} should have returned the secret on register`)
      }
      return "configured (PRINT_TRAIL_WEBHOOK_SECRET)"
    })
    await t.check(
      "settings warnings",
      async () => {
        const warnings: string[] = view.warnings ?? []
        const serious = warnings.filter((w) => SERIOUS_WARNINGS.has(w))
        if (serious.length) fail(`warnings: ${warnings.join(", ")}`)
        return warnings.length ? `minor: ${warnings.join(", ")}` : "none"
      },
      { soft: true }
    )
  },
}

export const apiVersion: Scenario = {
  id: "api-version",
  title: "Print Trail API version",
  run: async (t) => {
    const { ctx } = t
    await t.check(
      "Print Trail reports its API version",
      async () => {
        await ctx.pt.client.getToken()
        if (!ctx.pt.apiVersion) skip("no Print-Trail-Api-Version header (a Print Trail API before 1.1.0)")
        return ctx.pt.apiVersion!
      },
      { soft: true }
    )
    await t.check("the settings page shows it", async () => {
      const view = await ctx.medusa.connection()
      if (!("api_version" in view)) skip("this plugin build doesn't show the API version")
      if (!ctx.pt.apiVersion) {
        expect(view.api_version === null, "the plugin shows a version Print Trail didn't send")
        return "not reported, as expected"
      }
      expect(view.api_version?.version === ctx.pt.apiVersion, `plugin shows ${view.api_version?.version ?? "none"}, Print Trail sent ${ctx.pt.apiVersion}`)
      return view.api_version.version
    })
  },
}

export const stock: Scenario = {
  id: "stock",
  title: "Stock sync and SKU health",
  needs: (ctx) => (ctx.variants.stocked ? null : "no variant resolves to PT_STOCKED_SKU"),
  run: async (t) => {
    const { ctx } = t
    const v = ctx.variants.stocked!
    await t.check("configured SKUs are matched", async () => {
      const health = await ctx.medusa.skuHealth()
      const roles = (["stocked", "second", "preOrderUnlimited", "preOrderLimited"] as const).filter((r) => ctx.variants[r])
      const bad: string[] = []
      for (const role of roles) {
        const variant = ctx.variants[role]!
        const view = await ctx.medusa.variantView(variant.id)
        const status = view.check?.status ?? "unchecked"
        const okStatus = role.startsWith("preOrder") ? ["matched", "pre-order"] : ["matched"]
        if (!okStatus.includes(status)) bad.push(`${variant.sku}: ${status}`)
        if ((health.unmatched ?? []).some((s: string) => s.toLowerCase() === variant.sku.toLowerCase())) bad.push(`${variant.sku}: unmatched`)
      }
      expect(bad.length === 0, bad.join("; "))
      return `${roles.length} SKU(s) matched`
    })
    await t.check("Medusa stock follows Print Trail", async () => {
      if (ctx.mock) {
        // A stock change at Print Trail, then its webhook: a full stock sync.
        const target = 41
        const mock = ctx.mock
        const before = mock.state.stock[v.sku]
        // Put the mock's figure back, and sync it into Medusa, at the end.
        ctx.undo.push({
          what: `restore the stock of ${v.sku}`,
          run: async () => {
            if (before === undefined) {
              // The mock had no figure: drop it again; the plugin leaves an unknown SKU's stock alone.
              delete mock.state.stock[v.sku]
              return
            }
            mock.state.stock[v.sku] = before
            await sleep(1100)
            await mock.sendWebhook("stock-level-updated")
            await waitFor(
              "Medusa's stock to be restored",
              async () => (await ctx.medusa.stockLevels(v.id)).every((n) => n === before),
              { timeoutMs: 30_000, intervalMs: 1000 }
            )
          },
        })
        mock.state.stock[v.sku] = target
        const res = await ctx.mock.sendWebhook("stock-level-updated")
        expect(res.status < 300, `stock webhook answered ${res.status}`)
        const levels = await waitFor(
          "Medusa's stock to change",
          async () => {
            const levels = await ctx.medusa.stockLevels(v.id)
            return levels.length && levels.every((n) => n === target) ? levels : null
          },
          { timeoutMs: ctx.config.timeouts.webhook }
        )
        return `stock-level-updated webhook set ${levels.length} location level(s) to ${target}`
      }
      const row = await ctx.pt.stockRow(v.sku)
      expect(row, `Print Trail's stock levels don't list ${v.sku}`)
      if (row.stock >= 10000) skip(`${v.sku} is print on demand at Print Trail; the plugin turns on backorders instead`)
      const health = await ctx.medusa.skuHealth()
      if (!health.lastRun?.completedAt) {
        manual("no stock sync has run: run the print-trail-stock-sync job (or wait for PRINT_TRAIL_STOCK_SCHEDULE) and re-run --only stock")
      }
      const levels = await ctx.medusa.stockLevels(v.id)
      expect(
        levels.length && levels.every((n) => n === row.stock),
        `Medusa ${levels.join("/") || "no inventory level"}, Print Trail ${row.stock} (last sync ${health.lastRun.completedAt}; stock may have moved since)`
      )
      return `${row.stock} on both sides (last sync ${health.lastRun.completedAt})`
    })
    await t.check(
      "the last stock sync had no error",
      async () => {
        const run = (await ctx.medusa.skuHealth()).lastRun
        if (!run) skip("no stock sync has run")
        expect(!run.error, `last run: ${run.error}`)
        return `${run.levelsUpdated} level(s) updated, trigger ${run.trigger}`
      },
      { soft: true }
    )
  },
}

export const unmatchedSku: Scenario = {
  id: "unmatched-sku",
  title: "An unknown SKU is flagged (temporary override on the stocked variant)",
  needs: (ctx) => (ctx.variants.stocked ? null : "no variant resolves to PT_STOCKED_SKU"),
  run: async (t) => {
    const { ctx } = t
    const v = ctx.variants.stocked!
    const bogus = `CHECKLIST-UNKNOWN-${ctx.config.runId}`.toUpperCase()
    const original = await ctx.medusa.variantMetadata(v.productId, v.id)
    let restored = false
    const restore = async () => {
      if (restored) return
      await ctx.medusa.restoreVariantMetadata(v.productId, v.id, original)
      restored = true
    }
    ctx.undo.push({ what: `restore the metadata of variant ${v.id}`, run: restore })
    await t.check("the SKU check flags an unknown override", async () => {
      await ctx.medusa.setVariantMetadata(v.productId, v.id, { ...original, print_trail_sku: bogus })
      const view = await waitFor(
        "the SKU check of the changed variant",
        async () => {
          const view = await ctx.medusa.variantView(v.id)
          return view.check?.sku?.toUpperCase() === bogus && view.check_current ? view : null
        },
        { timeoutMs: 60_000 }
      )
      expect(view.check.status !== "matched", "an unknown SKU was reported as matched")
      return `status ${view.check.status}`
    })
    await t.check(
      "SKU health lists the variant",
      async () => {
        const health = await ctx.medusa.skuHealth()
        expect((health.problems ?? []).some((p: any) => p.variant_id === v.id), "not in the SKU health problems")
        return "listed"
      },
      { soft: true }
    )
    await t.check("restoring the variant clears it", async () => {
      await restore()
      const back = await ctx.medusa.variantMetadata(v.productId, v.id)
      expect(sameMetadata(back, original), `metadata not restored: fix print_trail_sku on variant ${v.id} by hand`)
      await waitFor(
        "the SKU check to match again",
        async () => {
          const view = await ctx.medusa.variantView(v.id)
          return view.check_current && view.check?.status === "matched"
        },
        { timeoutMs: 60_000 }
      )
      return "matched again"
    })
  },
}
