// The store under test, through its HTTP APIs only: the admin API (as an
// admin user) and the store API (as a shopper). Errors carry the status and a
// short body, never the request's headers.
import { resolveSku, skusMatch } from "../../../src/lib/sku"
import { LEGACY_SKU_CHECK_KEY } from "../../../src/lib/variant-checks"
import type { Config } from "./config"
import { ChecklistError } from "./runner"

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: any
  ) {
    super(`${method} ${path} -> ${status}${body?.message ? `: ${String(body.message).slice(0, 200)}` : ""}`)
  }
}

type Opts = { method?: string; body?: unknown; query?: Record<string, string | number | undefined> }

export const PT_PROVIDER_ID = "print-trail_print-trail"

const ORDER_FIELDS = [
  "id",
  "display_id",
  "status",
  "email",
  "canceled_at",
  "items.id",
  "items.quantity",
  "items.detail.quantity",
  "items.variant_id",
  "fulfillments.id",
  "fulfillments.shipped_at",
  "fulfillments.canceled_at",
  "fulfillments.labels.tracking_number",
  "fulfillments.labels.tracking_url",
  "payment_collections.payments.id",
  "payment_collections.payments.amount",
  "payment_collections.payments.captured_at",
].join(",")

// An order item's current quantity (an order edit changes detail.quantity).
export const itemQuantity = (item: any): number => Number(item.detail?.quantity ?? item.quantity)

// Before 1.0.0 the plugin stored a variant's SKU check in its metadata; a
// store upgraded from 0.2.0 may still carry it until the metadata scan runs.
export const withoutSkuCheck = (metadata: Record<string, unknown>) => {
  const { [LEGACY_SKU_CHECK_KEY]: _check, ...rest } = metadata
  return rest
}

// Metadata as it was, with the plugin's stored check dropped and the
// override present explicitly.
export const restoredMetadata = (metadata: Record<string, unknown>) => ({
  ...withoutSkuCheck(metadata),
  print_trail_sku: metadata.print_trail_sku ?? "",
})

// Same metadata, ignoring the stored check and an empty override.
export const sameMetadata = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const norm = (m: Record<string, unknown>) => {
    const rest: Record<string, unknown> = withoutSkuCheck(m)
    if (rest.print_trail_sku === "" || rest.print_trail_sku == null) delete rest.print_trail_sku
    return JSON.stringify(Object.keys(rest).sort().map((k) => [k, rest[k]]))
  }
  return norm(a) === norm(b)
}

export class Medusa {
  private token: string | null = null

  constructor(private readonly config: Config) {}

  private async request(path: string, opts: Opts & { headers?: Record<string, string> } = {}): Promise<any> {
    const method = opts.method ?? (opts.body === undefined ? "GET" : "POST")
    const url = new URL(path, this.config.storeUrl)
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v))
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json", ...opts.headers },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      // A redirect could lead anywhere, a forbidden store included.
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    })
    const text = await res.text()
    let body: any = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = { message: text.slice(0, 200) }
    }
    if (!res.ok) throw new HttpError(res.status, method, url.pathname, body)
    return body
  }

  async login(): Promise<void> {
    const { token } = await this.request("/auth/user/emailpass", {
      body: { email: this.config.admin.email, password: this.config.admin.password },
    })
    this.token = token
  }

  admin(path: string, opts: Opts = {}): Promise<any> {
    return this.request(path, { ...opts, headers: { authorization: `Bearer ${this.token}` } })
  }

  shop(path: string, opts: Opts = {}): Promise<any> {
    return this.request(path, { ...opts, headers: { "x-publishable-api-key": this.config.publishableKey } })
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(new URL("/health", this.config.storeUrl), { redirect: "error", signal: AbortSignal.timeout(5000) })
      return res.ok
    } catch {
      return false
    }
  }

  // --- admin reads ---

  async order(id: string): Promise<any> {
    return (await this.admin(`/admin/orders/${id}`, { query: { fields: ORDER_FIELDS } })).order
  }

  // The plugin's view of an order: rows, fulfilments, timeline.
  ptView(orderId: string): Promise<any> {
    return this.admin(`/admin/print-trail/orders/${orderId}`)
  }

  connection(): Promise<any> {
    return this.admin("/admin/print-trail/connection")
  }

  testConnection(): Promise<any> {
    return this.admin("/admin/print-trail/connection", { method: "POST", body: {} })
  }

  skuHealth(): Promise<any> {
    return this.admin("/admin/print-trail/sku-health")
  }

  variantView(variantId: string): Promise<any> {
    return this.admin(`/admin/print-trail/variants/${variantId}`)
  }

  // The newest notifications with this template (the route can't filter on it).
  async notifications(template: string): Promise<any[]> {
    const { notifications } = await this.admin("/admin/notifications", {
      query: { limit: 200, order: "-created_at", fields: "id,template,channel,data,created_at" },
    })
    return (notifications ?? []).filter((n: any) => n.template === template)
  }

  // --- admin writes ---

  // Re-register; force confirms a URL the plugin calls unsafe (http, local).
  registerWebhook(force: boolean): Promise<any> {
    return this.admin("/admin/print-trail/webhook", { body: { force } })
  }

  cancelOrder(id: string): Promise<any> {
    return this.admin(`/admin/orders/${id}/cancel`, { method: "POST", body: {} })
  }

  resend(orderId: string, body: { as_new?: boolean; print_trail_order_id?: string } = {}): Promise<any> {
    return this.admin(`/admin/print-trail/orders/${orderId}/resend`, { method: "POST", body })
  }

  refresh(orderId: string): Promise<any> {
    return this.admin(`/admin/print-trail/orders/${orderId}/refresh`, { method: "POST", body: {} })
  }

  // One confirmed order edit changing an item's quantity (as the harness does).
  async editItemQuantity(orderId: string, itemId: string, quantity: number): Promise<void> {
    await this.admin("/admin/order-edits", { body: { order_id: orderId } })
    await this.admin(`/admin/order-edits/${orderId}/items/item/${itemId}`, { body: { quantity } })
    await this.admin(`/admin/order-edits/${orderId}/request`, { body: {} })
    await this.admin(`/admin/order-edits/${orderId}/confirm`, { body: {} })
  }

  capturePayment(paymentId: string): Promise<any> {
    return this.admin(`/admin/payments/${paymentId}/capture`, { body: {} })
  }

  refundPayment(paymentId: string, amount: number): Promise<any> {
    return this.admin(`/admin/payments/${paymentId}/refund`, { body: { amount } })
  }

  async variantMetadata(productId: string, variantId: string): Promise<Record<string, unknown>> {
    const { variant } = await this.admin(`/admin/products/${productId}/variants/${variantId}`, { query: { fields: "id,metadata" } })
    return variant.metadata ?? {}
  }

  setVariantMetadata(productId: string, variantId: string, metadata: Record<string, unknown>): Promise<any> {
    return this.admin(`/admin/products/${productId}/variants/${variantId}`, { body: { metadata } })
  }

  // Writes metadata back without the plugin's stored SKU check, so the plugin
  // checks the variant afresh instead of trusting the old result.
  // The override is written back explicitly (an empty string when there was
  // none, which the plugin reads as no override), rather than trusting the
  // update to drop the key.
  restoreVariantMetadata(productId: string, variantId: string, metadata: Record<string, unknown>): Promise<any> {
    return this.setVariantMetadata(productId, variantId, restoredMetadata(metadata))
  }

  // Orders this run placed, by the cart metadata it sets (copied to the order).
  async findRunOrders(runId: string, since: string): Promise<{ id: string; displayId: number | null }[]> {
    const found: { id: string; displayId: number | null }[] = []
    for (let offset = 0; offset < 2000; offset += 100) {
      const { orders } = await this.admin("/admin/orders", {
        query: { "created_at[$gte]": since, fields: "id,display_id,metadata", limit: 100, offset, order: "created_at" },
      })
      for (const o of orders ?? []) if (o.metadata?.print_trail_checklist === runId) found.push({ id: o.id, displayId: o.display_id ?? null })
      if ((orders ?? []).length < 100) break
    }
    return found
  }

  // The admin session token, for redaction.
  get adminToken(): string | null {
    return this.token
  }

  // On-hand stock of a variant's inventory item at each location. The plugin
  // writes Print Trail's figure to every location it manages.
  async stockLevels(variantId: string): Promise<number[]> {
    const { variants } = await this.admin("/admin/product-variants", {
      query: { id: variantId, fields: "id,inventory_items.inventory_item_id" },
    })
    const itemId = variants?.[0]?.inventory_items?.[0]?.inventory_item_id
    if (!itemId) return []
    const { inventory_levels } = await this.admin(`/admin/inventory-items/${itemId}/location-levels`)
    return (inventory_levels ?? []).map((l: any) => Number(l.stocked_quantity ?? 0))
  }

  // --- store discovery ---

  // Print Trail shipping options and the profiles they serve.
  async printTrailOptions(): Promise<{ id: string; shipping_profile_id: string }[]> {
    const { shipping_options } = await this.admin("/admin/shipping-options", {
      query: { limit: 200, fields: "id,provider_id,shipping_profile_id" },
    })
    return (shipping_options ?? []).filter((o: any) => o.provider_id === PT_PROVIDER_ID)
  }

  // The variant that resolves to a Print Trail SKU (the print_trail_sku
  // override first, then the variant's own SKU) and that the plugin counts as
  // in a Print Trail shipping profile.
  async findVariant(sku: string): Promise<{ id: string; productId: string; sku: string | null } | null> {
    const fields = "id,sku,metadata,product_id"
    const candidates: any[] = []
    const direct = await this.admin("/admin/product-variants", { query: { sku, fields, limit: 50 } })
    candidates.push(...(direct.variants ?? []).filter((v: any) => skusMatch(resolveSku(v), sku)))
    for (let offset = 0; offset < 5000; offset += 200) {
      const page = await this.admin("/admin/product-variants", { query: { fields, limit: 200, offset } })
      candidates.push(...(page.variants ?? []).filter((v: any) => skusMatch(resolveSku(v), sku)))
      if ((page.variants ?? []).length < 200) break
    }
    const seen = new Set<string>()
    for (const v of candidates) {
      if (seen.has(v.id)) continue
      seen.add(v.id)
      if ((await this.variantView(v.id)).in_print_trail_profile) return { id: v.id, productId: v.product_id, sku: v.sku ?? null }
    }
    return null
  }

  // --- shopping ---

  // Places one order through the store API, shipped with a Print Trail option,
  // paid with the system provider. Returns the order id and display id.
  async placeOrder(input: {
    regionId: string
    email: string
    runId: string
    countryCode: string
    lines: { variantId: string; quantity: number }[]
    shippingOptionIds: Set<string>
  }): Promise<{ id: string; displayId: number }> {
    const address = {
      first_name: "Checklist",
      last_name: input.runId,
      address_1: "1 Test Street",
      city: "London",
      postal_code: "N1 1AA",
      country_code: input.countryCode,
      phone: "02000000000",
    }
    let { cart } = await this.shop("/store/carts", {
      body: {
        region_id: input.regionId,
        email: input.email,
        items: input.lines.map((l) => ({ variant_id: l.variantId, quantity: l.quantity })),
        shipping_address: address,
        billing_address: address,
        metadata: { print_trail_checklist: input.runId },
      },
    })
    const { shipping_options } = await this.shop("/store/shipping-options", { query: { cart_id: cart.id } })
    const option = (shipping_options ?? []).find((o: any) => input.shippingOptionIds.has(o.id))
    if (!option) throw new ChecklistError("no Print Trail shipping option is offered for this cart (region, zone or rules)")
    ;({ cart } = await this.shop(`/store/carts/${cart.id}/shipping-methods`, { body: { option_id: option.id, data: {} } }))
    const { payment_collection } = await this.shop("/store/payment-collections", { body: { cart_id: cart.id } })
    await this.shop(`/store/payment-collections/${payment_collection.id}/payment-sessions`, {
      body: { provider_id: "pp_system_default" },
    })
    const done = await this.shop(`/store/carts/${cart.id}/complete`, { body: {} })
    if (done.type !== "order") throw new ChecklistError(`cart completion returned ${done.type}: ${done.error?.message ?? "no order"}`)
    return { id: done.order.id, displayId: done.order.display_id }
  }

  async regionFor(countryCode: string, regionId: string | null): Promise<string> {
    const { regions } = await this.shop("/store/regions", { query: { fields: "id,countries.iso_2", limit: 100 } })
    const region = regionId
      ? regions.find((r: any) => r.id === regionId)
      : regions.find((r: any) => (r.countries ?? []).some((c: any) => c.iso_2 === countryCode))
    if (!region) throw new ChecklistError(regionId ? "CHECKLIST_REGION_ID isn't a region of this store" : `no region ships to ${countryCode}`)
    return region.id
  }
}
