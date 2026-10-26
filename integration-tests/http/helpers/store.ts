// Orders for the harness: through the store API (emits order.placed), or
// straight through createOrderWorkflow (emits nothing, as a lost event would).
import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createOrderWorkflow } from "@medusajs/medusa/core-flows"
import type { AxiosInstance } from "axios"
import { RATE_CARD, type Seed } from "./seed"

export type Line = { variantId: string; quantity: number }
export type Address = {
  first_name: string
  last_name: string
  address_1: string
  city: string
  postal_code: string
  country_code: string
  phone: string
}

export const ADDRESS: Address = {
  first_name: "Ada",
  last_name: "Lovelace",
  address_1: "1 Analytical Street",
  city: "London",
  postal_code: "N1 1AA",
  country_code: "gb",
  phone: "02000000000",
}

const storeHeaders = (seed: Seed) => ({ headers: { "x-publishable-api-key": seed.publishableKey } })

// cart → items → address → one shipping method per profile present →
// payment session (pp_system_default) → complete.
export async function placeOrder(
  api: AxiosInstance,
  seed: Seed,
  lines: Line[],
  opts: { address?: Partial<Address> } = {}
): Promise<{ orderId: string; displayId: number }> {
  const h = storeHeaders(seed)
  const address = { ...ADDRESS, ...opts.address }
  const {
    data: { cart },
  } = await api.post(
    "/store/carts",
    {
      region_id: seed.regionId,
      email: "ada@harness.test",
      items: lines.map((l) => ({ variant_id: l.variantId, quantity: l.quantity })),
      shipping_address: address,
      billing_address: address,
    },
    h
  )
  // Every seeded variant but `plain` is in the Print Trail profile.
  const optionIds = [
    ...(lines.some((l) => l.variantId !== seed.variants.plain) ? [seed.ptOptionId] : []),
    ...(lines.some((l) => l.variantId === seed.variants.plain) ? [seed.manualOptionId] : []),
  ]
  for (const optionId of optionIds) {
    await api.post(`/store/carts/${cart.id}/shipping-methods`, { option_id: optionId, data: {} }, h)
  }
  const {
    data: { payment_collection },
  } = await api.post("/store/payment-collections", { cart_id: cart.id }, h)
  await api.post(
    `/store/payment-collections/${payment_collection.id}/payment-sessions`,
    { provider_id: "pp_system_default" },
    h
  )
  const { data } = await api.post(`/store/carts/${cart.id}/complete`, {}, h)
  if (data.type !== "order") {
    // eslint-disable-next-line @medusajs/use-medusa-error-not-generic-error
    throw new Error(`cart complete returned ${JSON.stringify(data).slice(0, 400)}`)
  }
  return { orderId: data.order.id, displayId: data.order.display_id }
}

// core-flows createOrderWorkflow, no cart: emits no order.placed. address:
// null leaves both addresses off; a partial address is merged over ADDRESS.
export async function createOrderDirect(
  container: MedusaContainer,
  seed: Seed,
  lines: Line[],
  opts: { address?: Partial<Address> | null } = {}
): Promise<{ orderId: string; displayId: number }> {
  const address = opts.address === null ? undefined : { ...ADDRESS, ...opts.address }
  const hasPt = lines.some((l) => l.variantId !== seed.variants.plain)
  const hasPlain = lines.some((l) => l.variantId === seed.variants.plain)
  const { result } = await createOrderWorkflow(container).run({
    input: {
      region_id: seed.regionId,
      sales_channel_id: seed.salesChannelId,
      email: "ada@harness.test",
      currency_code: "gbp",
      items: lines.map((l) => ({ variant_id: l.variantId, quantity: l.quantity })),
      shipping_address: address,
      billing_address: address,
      shipping_methods: [
        ...(hasPt
          ? [{ name: "Print Trail Tracked", amount: RATE_CARD.bands[0].prices.gbp, shipping_option_id: seed.ptOptionId, data: {} }]
          : []),
        ...(hasPlain ? [{ name: "Standard", amount: 2, shipping_option_id: seed.manualOptionId, data: {} }] : []),
      ],
    } as any,
  })
  return { orderId: result.id, displayId: result.display_id as number }
}

export async function backdateOrder(dbConnection: any, orderId: string, minutes: number): Promise<void> {
  await dbConnection.raw(`update "order" set created_at = now() - make_interval(mins => ?) where id = ?`, [
    minutes,
    orderId,
  ])
}

export async function orderItems(container: MedusaContainer, orderId: string): Promise<any[]> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: ["id", "items.id", "items.variant_id", "items.quantity"],
    filters: { id: orderId },
  })
  return data[0]?.items ?? []
}
