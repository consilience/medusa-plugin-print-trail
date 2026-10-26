// The Print Trail side. Reads go through the plugin's own client. Changes a
// person makes in the Print Trail app (dispatch, a status change, a release)
// come from a Driver: in --mock mode the in-process mock does them; against
// staging the tester does, and the driver polls until they show.
import { createServer } from "node:net"
import { startMockPrintTrail, type MockPrintTrail } from "../../../dev/mock-print-trail"
import { PrintTrailClient } from "../../../src/modules/printTrail/client/client"
import type { PtOrder } from "../../../src/modules/printTrail/client/types"
import type { Config } from "./config"
import { ChecklistError, humanStep, skip } from "./runner"

export type PtRef = { uuid: string; number: string }

// Read-only use of the plugin's client, remembering the Print-Trail-Api-Version
// header (API 1.1.0 and later send it on every response).
export class PrintTrailReader {
  readonly client: PrintTrailClient
  apiVersion: string | null = null

  constructor(config: Config) {
    const recordingFetch: typeof fetch = async (input, init) => {
      const res = await fetch(input, init)
      const version = res.headers.get("print-trail-api-version")?.trim()
      if (version) this.apiVersion = version
      return res
    }
    this.client = new PrintTrailClient({ ...config.printTrail, fetch: recordingFetch, retryDelays: [1000, 2000] })
  }

  order(uuid: string): Promise<PtOrder> {
    return this.client.getOrder(uuid)
  }

  async stockRow(sku: string): Promise<Record<string, any> | null> {
    const rows = await this.client.stockLevels()
    return (rows.find((r) => r.sku === sku) as Record<string, any> | undefined) ?? null
  }
}

export const dispatched = (o: PtOrder, index?: number) => {
  const fs = o.fulfilments ?? []
  if (index !== undefined) return fs[index]?.status === "dispatched"
  return fs.length > 0 && fs.every((f) => f.status === "dispatched" || f.status === "cancelled")
}

export type Driver = {
  kind: "mock" | "human"
  // A status change made at Print Trail, delivered by webhook.
  changeStatus(o: PtRef, before: string): Promise<void>
  // Dispatch with tracking, then the webhooks. index: one fulfilment only.
  dispatch(o: PtRef, index?: number): Promise<void>
  // Dispatch with no webhook reaching the store yet (cancel too late).
  dispatchQuietly(o: PtRef): Promise<void>
  cancelAtPrintTrail(o: PtRef): Promise<void>
  releasePreOrder(sku: string, o: PtRef): Promise<void>
}

export class MockDriver implements Driver {
  readonly kind = "mock" as const
  constructor(readonly mock: MockPrintTrail) {}

  private async hooks(uuid: string, ...types: string[]) {
    for (const type of types) {
      const res = await this.mock.sendWebhook(type, uuid)
      if (res.status >= 300) throw new ChecklistError(`the store answered the ${type} webhook with ${res.status}`)
    }
  }

  async changeStatus(o: PtRef) {
    this.mock.setStatus(o.uuid, "processing")
    await this.hooks(o.uuid, "order-status-updated")
  }

  async dispatch(o: PtRef, index?: number) {
    this.mock.dispatch(o.uuid, index)
    await this.hooks(o.uuid, "fulfilment-status-updated", "fulfilment-tracking-created", "order-status-updated")
  }

  async dispatchQuietly(o: PtRef) {
    this.mock.dispatch(o.uuid)
  }

  async cancelAtPrintTrail(o: PtRef) {
    this.mock.setStatus(o.uuid, "cancelled")
    await this.hooks(o.uuid, "order-status-updated")
  }

  // The mock (API 1.3.0) releases on setSkuStatus/restock, sending its webhooks.
  async releasePreOrder(sku: string) {
    const m = this.mock as any
    if (typeof m.setSkuStatus !== "function") skip("this mock has no pre-order release")
    await m.setSkuStatus(sku, "active")
    if (typeof m.restock === "function") await m.restock(sku, 100)
  }
}

export class HumanDriver implements Driver {
  readonly kind = "human" as const
  constructor(
    private readonly config: Config,
    private readonly pt: PrintTrailReader
  ) {}

  private step<T>(title: string, steps: string[], until: () => Promise<T | null | false>, intervalMs?: number) {
    return humanStep({ interactive: this.config.interactive, title, steps, until, timeoutMs: this.config.timeouts.human, intervalMs })
  }

  async changeStatus(o: PtRef, before: string) {
    await this.step(
      `Change the status of Print Trail order ${o.number}`,
      [`In the Print Trail staging app, open order ${o.number}`, `Change its status (it is "${before}"), for example by putting it on hold`],
      async () => (await this.pt.order(o.uuid)).status !== before
    )
  }

  async dispatch(o: PtRef, index?: number) {
    const which = index === undefined ? "every fulfilment" : `fulfilment ${index + 1} only (leave the others)`
    await this.step(
      `Dispatch Print Trail order ${o.number}`,
      [`In the Print Trail staging app, open order ${o.number}`, `Dispatch ${which}, with a tracking number`],
      async () => {
        const pt = await this.pt.order(o.uuid)
        const done = dispatched(pt, index)
        const tracked = (pt.fulfilments ?? []).some((f) => (f.trackingDetails ?? []).length > 0)
        return done && tracked
      }
    )
  }

  async dispatchQuietly(o: PtRef) {
    // The store cancels the moment Print Trail shows the dispatch, to beat the
    // webhook. If the webhook wins, Medusa refuses the cancel and the check skips.
    await this.step(
      `Dispatch Print Trail order ${o.number}`,
      [`In the Print Trail staging app, open order ${o.number}`, "Dispatch it with a tracking number", "The script cancels the Medusa order as soon as it sees the dispatch"],
      async () => dispatched(await this.pt.order(o.uuid)),
      1000
    )
  }

  async cancelAtPrintTrail(o: PtRef) {
    await this.step(
      `Cancel Print Trail order ${o.number} in the Print Trail app`,
      [`In the Print Trail staging app, open order ${o.number}`, "Cancel it there (not in Medusa)"],
      async () => (await this.pt.order(o.uuid)).status === "cancelled"
    )
  }

  async releasePreOrder(sku: string, o: PtRef) {
    await this.step(
      `Release pre-order SKU ${sku}`,
      [
        `In the Print Trail staging app, make product ${sku} active and give it stock`,
        "This changes the product for good: it is no longer a pre-order SKU for later runs",
        `Wait for order ${o.number}'s waiting fulfilment to move on`,
      ],
      async () => {
        const pt = await this.pt.order(o.uuid)
        return (pt.fulfilments ?? []).every((f) => f.status !== "back-order")
      }
    )
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once("error", () => resolve(false))
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)))
  })
}

// Starts the bundled mock where the store expects Print Trail to be.
export async function startMock(config: Config): Promise<MockPrintTrail> {
  const port = Number(new URL(config.printTrail.baseUrl).port)
  const skus: Record<string, number> = { [config.skus.stocked]: 50 }
  const locations: Record<string, string> = { [config.skus.stocked]: "LOC-A" }
  if (config.skus.second) {
    skus[config.skus.second] = 50
    locations[config.skus.second] = "LOC-B"
  }
  const skuStatus: Record<string, "pre-order"> = {}
  for (const sku of [config.skus.preOrderUnlimited, config.skus.preOrderLimited]) {
    if (sku) {
      skus[sku] = 0
      skuStatus[sku] = "pre-order"
    }
  }
  const opts: Record<string, unknown> = {
    port,
    token: config.printTrail.apiToken,
    channelId: config.printTrail.channelId,
    webhookSecret: config.mockWebhookSecret,
    skus,
    locations,
    skuStatus,
  }
  // Read by a mock with pre-orders; ignored by older ones.
  if (config.skus.preOrderLimited) opts.preOrderLimit = { [config.skus.preOrderLimited]: 5 }
  if (!(await portFree(port))) throw new ChecklistError(`127.0.0.1:${port} is in use: stop the mock (or whatever holds it) first`)
  return startMockPrintTrail(opts as never)
}

