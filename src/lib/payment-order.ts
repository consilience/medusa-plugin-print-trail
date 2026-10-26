import type { RemoteQueryFunction } from "@medusajs/framework/types"

// payment.captured and payment.refunded carry the payment id. The order is
// reached through the payment collection's link (payment_collection.order is
// the order_link.order alias, as core-flows' refundPaymentsWorkflow reads it).
export const PAYMENT_FIELDS = [
  "id",
  "currency_code",
  "refunds.id",
  "refunds.amount",
  "refunds.created_at",
  "payment_collection.order.id",
]

export type GraphPayment = {
  id: string
  currency_code?: string | null
  refunds?: ({ id: string; amount?: number | string | null; created_at?: string | Date | null } | null)[] | null
  payment_collection?: { order?: { id?: string | null } | null } | null
}

export async function loadPayment(query: Omit<RemoteQueryFunction, symbol>, paymentId: string): Promise<GraphPayment | null> {
  const { data } = await query.graph({ entity: "payment", fields: PAYMENT_FIELDS, filters: { id: paymentId } })
  return (data[0] as unknown as GraphPayment | undefined) ?? null
}

export async function orderIdForPayment(query: Omit<RemoteQueryFunction, symbol>, paymentId: string): Promise<string | null> {
  return (await loadPayment(query, paymentId))?.payment_collection?.order?.id ?? null
}
