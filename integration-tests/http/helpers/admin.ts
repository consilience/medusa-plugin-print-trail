// Admin auth for the harness, as the Medusa docs page on testing API routes
// describes: a user, an emailpass auth identity, and a JWT signed with the
// fixture's jwtSecret.
import type { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import type { AxiosInstance } from "axios"
import jwt from "jsonwebtoken"
import { HARNESS } from "../harness"

export type Headers = { headers: Record<string, string> }

export async function adminHeaders(container: MedusaContainer): Promise<Headers> {
  const users = container.resolve(Modules.USER)
  const auth = container.resolve(Modules.AUTH)
  const user = await users.createUsers({ email: `admin-${Date.now()}@harness.test` })
  const identity = await auth.createAuthIdentities({
    provider_identities: [{ provider: "emailpass", entity_id: user.email }],
    app_metadata: { user_id: user.id },
  })
  const token = jwt.sign(
    { actor_id: user.id, actor_type: "user", auth_identity_id: identity.id },
    HARNESS.jwtSecret,
    { expiresIn: "1d" }
  )
  return { headers: { authorization: `Bearer ${token}` } }
}

// One confirmed order edit (the admin order-edit routes take the order id).
async function editOrder(
  api: AxiosInstance,
  headers: Headers,
  orderId: string,
  change: () => Promise<unknown>
): Promise<void> {
  await api.post("/admin/order-edits", { order_id: orderId }, headers)
  await change()
  await api.post(`/admin/order-edits/${orderId}/request`, {}, headers)
  await api.post(`/admin/order-edits/${orderId}/confirm`, {}, headers)
}

export function editItemQuantity(
  api: AxiosInstance,
  headers: Headers,
  orderId: string,
  itemId: string,
  quantity: number
): Promise<void> {
  return editOrder(api, headers, orderId, () =>
    api.post(`/admin/order-edits/${orderId}/items/item/${itemId}`, { quantity }, headers)
  )
}

// 2.17.2 has no route that removes an original item from an edit
// (DELETE …/items/:action_id only undoes an added item), so removing one is
// setting its quantity to 0.
export function removeItem(api: AxiosInstance, headers: Headers, orderId: string, itemId: string): Promise<void> {
  return editItemQuantity(api, headers, orderId, itemId, 0)
}
