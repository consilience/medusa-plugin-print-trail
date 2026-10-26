import { resolvePluginOptions } from "../../../config"
import { toAttentionRows } from "../attention"

const options = resolvePluginOptions({ baseUrl: "https://api.printtrail.com" })
const row = (over: Record<string, unknown> = {}) => ({
  id: "ptord_1",
  order_id: "order_1",
  sequence: 1,
  pt_order_number: "ORD-7",
  pt_uuid: "uuid-1",
  attention: "complete-manually",
  last_error: null,
  updated_at: new Date("2026-10-19T10:00:00Z"),
  ...over,
})

describe("attention rows", () => {
  it("lists a row whose order is missing", () => {
    const rows = toAttentionRows([row({ order_id: "order_gone" }) as never], new Map(), options, "acme")
    expect(rows).toEqual([
      {
        id: "ptord_1",
        order_id: "order_gone",
        display_id: null,
        pt_order_number: "ORD-7",
        pt_url: "https://app.printtrail.com/acme/orders/uuid-1",
        attention: "complete-manually",
        last_error: null,
        updated_at: "2026-10-19T10:00:00.000Z",
        dismissable: true,
      },
    ])
  })

  it("links each attention row to its Print Trail order", () => {
    const rows = toAttentionRows(
      [row() as never, row({ id: "ptord_2", sequence: 2, pt_order_number: "ORD-7-2", pt_uuid: null, attention: "retry-cap:send", last_error: "boom" }) as never],
      new Map([["order_1", 7]]),
      options,
      "acme"
    )
    expect(rows.map((r) => [r.display_id, r.pt_url, r.dismissable])).toEqual([
      [7, "https://app.printtrail.com/acme/orders/uuid-1", true],
      [7, null, false],
    ])
    expect(rows[1].last_error).toBe("boom")
    expect(toAttentionRows([row() as never], new Map(), options, null)[0].pt_url).toBeNull()
  })

  it("offers Dismiss for Print Trail's final codes", () => {
    const codes = ["pt-returned", "pt-fulfilment-returned", "pt-partial", "pt-fulfilment-failed", "pt-holding"]
    const rows = toAttentionRows(codes.map((attention, i) => row({ id: `ptord_${i}`, attention }) as never), new Map(), options, "acme")
    expect(rows.map((r) => r.dismissable)).toEqual([true, true, true, true, false])
  })
})
