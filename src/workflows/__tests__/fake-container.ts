import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { PrintTrailPluginOptions } from "../../config"
import type { PrintTrailClient } from "../../modules/printTrail/client/client"
import { PRINT_TRAIL_MODULE } from "../../modules/printTrail"
import type { MemoryStore } from "../../lib/__tests__/flow-fixtures"

// Just enough of a Medusa container to run a step handler over the
// in-memory store: the printTrail service, query.graph for orders, a logger
// and a notification module.
export function fakeContainer(opts: {
  store: MemoryStore
  client: PrintTrailClient
  options: PrintTrailPluginOptions
  orders: Record<string, { id: string; display_id?: number; canceled_at?: string | null; created_at?: string }>
  teamCode?: string
}) {
  const { store } = opts
  const notifications: unknown[] = []
  const logs: string[] = []
  const service = {
    listPrintTrailOrders: (f: Record<string, unknown>) => store.listPrintTrailOrders(f),
    updatePrintTrailOrders: (d: Record<string, unknown>) => store.updatePrintTrailOrders(d),
    createPrintTrailOrders: (d: Record<string, unknown>) => store.createPrintTrailOrders(d),
    createPrintTrailOrderEvents: (d: Record<string, unknown> | Record<string, unknown>[]) =>
      store.createPrintTrailOrderEvents(Array.isArray(d) ? d : [d]),
    listPrintTrailOrderEvents: (f: Record<string, unknown>) => store.listPrintTrailOrderEvents(f),
    markPreOrderSeen: (skus: string[]) => store.markPreOrderSeen(skus),
    getState: async (key: string) => (key === "team_code" ? { teamCode: opts.teamCode ?? "acme" } : null),
    setState: async () => {},
    getClient: async () => opts.client,
    getOptions: async () => opts.options,
    isConnected: async () => true,
  }
  const query = {
    graph: async ({ entity, filters }: { entity: string; filters: { id: string } }) => ({
      data: entity === "order" && opts.orders[filters.id] ? [opts.orders[filters.id]] : [],
    }),
  }
  const logger = { warn: (m: string) => logs.push(m), info: (m: string) => logs.push(m), error: (m: string) => logs.push(m), debug() {} }
  const registry: Record<string, unknown> = {
    [PRINT_TRAIL_MODULE]: service,
    [ContainerRegistrationKeys.QUERY]: query,
    [ContainerRegistrationKeys.LOGGER]: logger,
    [Modules.NOTIFICATION]: { createNotifications: async (n: unknown[]) => void notifications.push(...n) },
  }
  return { container: { resolve: (k: string) => registry[k] } as never, notifications, logs }
}
