import type {
  AttentionList,
  ConnectionTestResult,
  ConnectionView,
  DismissResult,
  OrderView,
  RateCardDto,
  RotateResult,
  RefreshResult,
  ResendResult,
  ShippingOptionChoices,
  ShippingOptionView,
  SkuHealthView,
  StockSyncNowView,
  VariantView,
} from "../../lib/admin-types"
import { sdk } from "./sdk"

// Every plugin route, through the JS SDK (session auth). Query keys follow
// ["print-trail", <resource>, ...args].
export const keys = {
  all: ["print-trail"] as const,
  connection: ["print-trail", "connection"] as const,
  shippingOptions: ["print-trail", "shipping-options"] as const,
  order: (id: string) => ["print-trail", "order", id] as const,
  attentionAll: ["print-trail", "attention"] as const,
  attention: (limit: number, offset: number) => ["print-trail", "attention", limit, offset] as const,
  skuHealth: ["print-trail", "sku-health"] as const,
  variant: (id: string) => ["print-trail", "variant", id] as const,
}

export type ShippingOptionBody = { name: string; service_zone_id: string; shipping_profile_id: string; rate_card: RateCardDto }

const base = "/admin/print-trail"

export const api = {
  connection: () => sdk.client.fetch<ConnectionView>(`${base}/connection`),
  testConnection: () => sdk.client.fetch<ConnectionTestResult>(`${base}/connection`, { method: "POST" }),
  registerWebhook: (force: boolean) =>
    sdk.client.fetch<ConnectionTestResult["webhook"]>(`${base}/webhook`, { method: "POST", body: { force } }),
  rotateWebhookSecret: () => sdk.client.fetch<RotateResult>(`${base}/webhook/rotate`, { method: "POST" }),
  shippingOptions: () =>
    sdk.client.fetch<{ shipping_options: ShippingOptionView[]; choices: ShippingOptionChoices }>(`${base}/shipping-options`),
  createShippingOption: (body: ShippingOptionBody) =>
    sdk.client.fetch<{ shipping_option: ShippingOptionView }>(`${base}/shipping-options`, { method: "POST", body }),
  updateShippingOption: (id: string, body: { name?: string; rate_card?: RateCardDto }) =>
    sdk.client.fetch<{ shipping_option: ShippingOptionView }>(`${base}/shipping-options/${id}`, { method: "POST", body }),
  deleteShippingOption: (id: string) => sdk.client.fetch<void>(`${base}/shipping-options/${id}`, { method: "DELETE" }),
  order: (id: string) => sdk.client.fetch<OrderView>(`${base}/orders/${id}`),
  refresh: (id: string) => sdk.client.fetch<RefreshResult>(`${base}/orders/${id}/refresh`, { method: "POST" }),
  resend: (id: string, body: { print_trail_order_id?: string; as_new?: boolean }) =>
    sdk.client.fetch<ResendResult>(`${base}/orders/${id}/resend`, { method: "POST", body }),
  dismiss: (id: string, body: { print_trail_order_id: string; attention: string }) =>
    sdk.client.fetch<DismissResult>(`${base}/orders/${id}/dismiss`, { method: "POST", body }),
  attention: (limit: number, offset: number) =>
    sdk.client.fetch<AttentionList>(`${base}/attention`, { query: { limit, offset } }),
  skuHealth: () => sdk.client.fetch<SkuHealthView>(`${base}/sku-health`),
  syncStockNow: () => sdk.client.fetch<StockSyncNowView>(`${base}/stock-sync`, { method: "POST", body: {} }),
  variant: (id: string) => sdk.client.fetch<VariantView>(`${base}/variants/${id}`),
}

// The JS SDK's FetchError carries the status and the body's `message` only;
// the plugin's refusals put their code there.
export function errorOf(e: unknown): { status: number | null; message: string } {
  const err = e as { status?: unknown; message?: unknown } | null
  return {
    status: typeof err?.status === "number" ? err.status : null,
    message: typeof err?.message === "string" ? err.message : "",
  }
}
