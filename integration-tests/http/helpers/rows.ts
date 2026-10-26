// Reads the plugin's rows and timeline through its module service, and the
// mock's request log. Tests may write rows to set up a crash; routes may not.
import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { MockPrintTrail } from "../../../dev/mock-print-trail"

export const printTrail = (container: MedusaContainer) => container.resolve<any>("printTrail")

export async function rowsFor(container: MedusaContainer, orderId: string): Promise<any[]> {
  const rows = await printTrail(container).listPrintTrailOrders({ order_id: orderId })
  return rows.sort((a: any, b: any) => a.sequence - b.sequence)
}

export async function rowFor(container: MedusaContainer, orderId: string): Promise<any | undefined> {
  return (await rowsFor(container, orderId))[0]
}

export async function eventsFor(container: MedusaContainer, orderId: string): Promise<any[]> {
  return printTrail(container).listPrintTrailOrderEvents({ order_id: orderId }, { order: { created_at: "ASC" } })
}

export async function updateRow(container: MedusaContainer, data: Record<string, unknown>): Promise<void> {
  await printTrail(container).updatePrintTrailOrders(data)
}

export async function linkExists(container: MedusaContainer, rowId: string, orderId: string): Promise<boolean> {
  const link = container.resolve(ContainerRegistrationKeys.LINK)
  const found = await link.list({
    printTrail: { print_trail_order_id: rowId },
    [Modules.ORDER]: { order_id: orderId },
  })
  return found.length > 0
}

export async function dismissLink(container: MedusaContainer, rowId: string, orderId: string): Promise<void> {
  const link = container.resolve(ContainerRegistrationKeys.LINK)
  await link.dismiss({
    printTrail: { print_trail_order_id: rowId },
    [Modules.ORDER]: { order_id: orderId },
  })
}

// Requests the mock received, by method and a pattern on the path.
export function requests(mock: MockPrintTrail, method: string, path: RegExp) {
  return mock.state.requests.filter((r) => r.method === method && path.test(r.path.split("?")[0]))
}

export const POSTS = /\/orders$/
export const CONFIRMS = /\/orders\/[^/]+\/confirm$/
export const CANCELS = /\/orders\/[^/]+\/cancel$/
export const LINES = /\/orders\/[^/]+\/lines$/

// The Print Trail orders the mock holds for one order number.
export function ptOrders(mock: MockPrintTrail, orderNumber: string): any[] {
  return [...mock.state.orders.values()].filter((o) => o.orderNumber === orderNumber)
}
