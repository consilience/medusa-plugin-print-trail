import { MedusaError } from "@medusajs/framework/utils"
import { isLockBusy } from "../../lib/stock-request"
import { patchVariantMetadata, type VariantMetadataStore } from "../../lib/variant-metadata"
import { backorderUpdates, legacyKeyPatches, listPluginMetadata, preOrderFieldPatches, toStockVariants } from "../steps/stock-context"

// The shape query.graph returns for STOCK_VARIANT_FIELDS (2.17.2): numeric
// columns can arrive as strings.
const graphVariants = [
  {
    id: "variant_1",
    sku: "plain-sku",
    metadata: { print_trail_sku: " PT-SKU-1 ", print_trail_backorder: true },
    manage_inventory: true,
    allow_backorder: true,
    product_id: "prod_1",
    inventory_items: [
      {
        inventory_item_id: "iitem_1",
        required_quantity: "1",
        inventory: {
          location_levels: [
            { location_id: "sloc_a", stocked_quantity: "7", reserved_quantity: "3" },
            { location_id: "sloc_b", stocked_quantity: 2 },
          ],
        },
      },
    ],
  },
  {
    id: "variant_2",
    sku: "OTHER",
    metadata: { print_trail_backorder: "true" },
    manage_inventory: true,
    allow_backorder: false,
    product_id: "prod_unlinked",
    inventory_items: [null],
  },
]

describe("toStockVariants", () => {
  it("maps the graph variant", () => {
    const [a, b] = toStockVariants(graphVariants, new Map([["prod_1", "sp_pt"]]))
    expect(a).toEqual({
      id: "variant_1",
      sku: "PT-SKU-1",
      profileId: "sp_pt",
      manageInventory: true,
      allowBackorder: true,
      inventory: [
        {
          inventoryItemId: "iitem_1",
          requiredQuantity: 1,
          levels: [
            { locationId: "sloc_a", stockedQuantity: 7, reservedQuantity: 3 },
            { locationId: "sloc_b", stockedQuantity: 2, reservedQuantity: 0 },
          ],
        },
      ],
    })
    expect(b).toMatchObject({ id: "variant_2", sku: "OTHER", profileId: null, inventory: [] })
    // The legacy marker in metadata isn't read: the reason is in stock_backordered.
    expect("backorderMarker" in a).toBe(false)
  })
})

describe("allow_backorder", () => {
  it("setBackorder sends only allow_backorder, by selector", () => {
    const ids = Array.from({ length: 150 }, (_, i) => `v${i}`)
    const updates = backorderUpdates(ids, true)
    // updateProductVariantsWorkflow's selector form, 100 variants at a time:
    // no metadata, so nothing else on the variant is written.
    expect(updates).toEqual([
      { selector: { id: ids.slice(0, 100) }, update: { allow_backorder: true } },
      { selector: { id: ids.slice(100) }, update: { allow_backorder: true } },
    ])
    expect(backorderUpdates(["v1"], false)).toEqual([{ selector: { id: ["v1"] }, update: { allow_backorder: false } }])
    expect(backorderUpdates([], true)).toEqual([])
  })
})

describe("print_trail_pre_order", () => {
  it("reads the stored value", () => {
    const [v] = toStockVariants([{ ...graphVariants[0], metadata: { print_trail_pre_order: "2026-12-01" } }], new Map())
    expect(v.preOrderField).toBe("2026-12-01")
  })

  it("writes through the merge, keeping other keys, and skips an unchanged value", async () => {
    const stored: Record<string, Record<string, unknown> | null> = {
      v1: { print_trail_sku: "A", print_trail_backorder: "pre-order" },
      v2: { print_trail_pre_order: "2026-12-01", print_trail_sku: "B" },
      v3: { print_trail_pre_order: true },
      v4: null,
    }
    const written: unknown[] = []
    const store: VariantMetadataStore = {
      async read(ids) {
        return ids.map((id) => ({ id, metadata: stored[id] }))
      },
      async write(rows) {
        written.push(...rows)
      },
    }
    await patchVariantMetadata(
      store,
      preOrderFieldPatches([
        { id: "v1", value: "2026-12-01" },
        { id: "v2", value: "2026-12-01" },
        { id: "v3", value: null },
        { id: "v4", value: null },
      ])
    )
    expect(written).toEqual([
      { id: "v1", metadata: { print_trail_sku: "A", print_trail_backorder: "pre-order", print_trail_pre_order: "2026-12-01" } },
      { id: "v3", metadata: {} },
    ])
  })
})

describe("stale keys", () => {
  // One write per variant deletes every key 0.2.0 kept there, through either
  // Medusa's replace (up to 2.18) or its merge (2.19+).
  it("the store's keys and print_trail_sku survive, in replace mode and in merge mode", async () => {
    const check = { sku: "A", status: "matched", checked_at: "t" }
    const stored: Record<string, Record<string, unknown> | null> = {
      v1: { print_trail_sku_check: check, print_trail_backorder: true, print_trail_pre_order: "2020-01-01", print_trail_sku: "A", store_key: 1 },
      v2: { print_trail_sku_check: check, print_trail_pre_order: "2026-12-01", print_trail_sku: 9780000000026 },
      // Nothing of 0.2.0's left: not written.
      v3: { print_trail_pre_order: "2026-12-01", store_key: 3 },
      v4: null,
    }
    const written: { mode: string; rows: unknown[] }[] = []
    for (const mode of ["replace", "merge"] as const) {
      const rows: unknown[] = []
      const store: VariantMetadataStore = {
        mode,
        async read(ids) {
          return ids.map((id) => ({ id, metadata: stored[id] }))
        },
        async write(r) {
          rows.push(...r)
        },
      }
      await patchVariantMetadata(
        store,
        legacyKeyPatches([
          // Outside the run's scope: the pre-order flag goes too.
          { id: "v1", preOrderField: true },
          { id: "v2", preOrderField: false },
          { id: "v3", preOrderField: false },
          { id: "v4", preOrderField: true },
        ])
      )
      written.push({ mode, rows })
    }
    // No allow_backorder, and print_trail_sku is kept (as a string).
    expect(written).toEqual([
      {
        mode: "replace",
        rows: [
          { id: "v1", metadata: { print_trail_sku: "A", store_key: 1 } },
          { id: "v2", metadata: { print_trail_pre_order: "2026-12-01", print_trail_sku: "9780000000026" } },
        ],
      },
      {
        mode: "merge",
        rows: [
          {
            id: "v1",
            metadata: { print_trail_sku_check: "", print_trail_backorder: "", print_trail_pre_order: "", print_trail_sku: "A", store_key: 1 },
          },
          { id: "v2", metadata: { print_trail_sku_check: "", print_trail_pre_order: "2026-12-01", print_trail_sku: "9780000000026" } },
        ],
      },
    ])
  })

  describe("listPluginMetadata", () => {
    // query.graph over variants: honours id $gt, orders by id, takes `take`.
    const variants = () => {
      let all = [
        { id: "v1", product_id: "prod_1", metadata: { print_trail_pre_order: "2026-12-01" } as Record<string, unknown> | null },
        { id: "v2", product_id: "prod_1", metadata: null },
        { id: "v3", product_id: "prod_2", metadata: { print_trail_backorder: "pre-order", other: 1 } },
        // Values 0.2.0 never wrote: no marker or check, but the keys are deleted.
        { id: "v4", product_id: "prod_2", metadata: { print_trail_backorder: "true", print_trail_pre_order: null } },
        {
          id: "v5",
          product_id: "prod_3",
          metadata: { print_trail_pre_order: true, print_trail_sku_check: { sku: "A", status: "not-found", checked_at: "t" } },
        },
        { id: "v6", product_id: "prod_3", metadata: { print_trail_sku_check: "matched" } },
        { id: "v7", product_id: "prod_3", metadata: { print_trail_sku: "B" } },
      ]
      const calls: unknown[] = []
      const query = {
        async graph(q: { entity: string; fields: string[]; filters?: { id?: { $gt?: string } }; pagination: { take: number; order: unknown } }) {
          calls.push(q)
          const after = q.filters?.id?.$gt
          const rows = all.filter((v) => after === undefined || v.id > after).sort((a, b) => a.id.localeCompare(b.id))
          return { data: rows.slice(0, q.pagination.take) }
        },
      }
      return { query, calls, remove: (id: string) => (all = all.filter((v) => v.id !== id)) }
    }

    it("reads a page by id after the cursor, keeping the variants with the plugin's keys", async () => {
      const { query, calls } = variants()
      const found = (id: string, productId: string, over: Record<string, unknown>) => ({
        id,
        productId,
        preOrderField: undefined,
        backorderMarker: null,
        check: null,
        legacyKeys: false,
        ...over,
      })
      expect(await listPluginMetadata(query as never, null, 2)).toEqual({
        found: [found("v1", "prod_1", { preOrderField: "2026-12-01" })],
        lastId: "v2",
        read: 2,
      })
      expect(await listPluginMetadata(query as never, "v2", 2)).toEqual({
        found: [found("v3", "prod_2", { backorderMarker: "pre-order", legacyKeys: true }), found("v4", "prod_2", { preOrderField: null, legacyKeys: true })],
        lastId: "v4",
        read: 2,
      })
      expect(await listPluginMetadata(query as never, "v4", 2)).toEqual({
        found: [
          found("v5", "prod_3", { preOrderField: true, check: { sku: "A", status: "not-found", checked_at: "t" }, legacyKeys: true }),
          found("v6", "prod_3", { legacyKeys: true }),
        ],
        lastId: "v6",
        read: 2,
      })
      expect(await listPluginMetadata(query as never, "v6", 2)).toEqual({ found: [], lastId: "v7", read: 1 })
      expect(await listPluginMetadata(query as never, "v7", 2)).toEqual({ found: [], lastId: null, read: 0 })
      // No filter on the first page, no skip on any.
      expect(calls[0]).toEqual({ entity: "product_variant", fields: ["id", "product_id", "metadata"], pagination: { take: 2, order: { id: "ASC" } } })
      expect(calls[1]).toEqual({
        entity: "product_variant",
        fields: ["id", "product_id", "metadata"],
        filters: { id: { $gt: "v2" } },
        pagination: { take: 2, order: { id: "ASC" } },
      })
    })

    // With skip/take, v1 deleted after the first page
    // gave [v1, v2], [v4, v5], [], and v3 was never read.
    it("reads v3 when v1 is deleted after the first page", async () => {
      const { query, remove } = variants()
      const read: string[] = []
      let after: string | null = null
      // Bounded, so a cursor that doesn't move fails instead of hanging.
      for (let i = 0; i < 10; i++) {
        const page = await listPluginMetadata(query as never, after, 2)
        if (after === null) remove("v1")
        read.push(...page.found.map((v) => v.id))
        if (page.read < 2) break
        after = page.lastId
      }
      expect(read).toEqual(["v1", "v3", "v4", "v5", "v6"])
    })
  })
})

describe("isLockBusy", () => {
  it("recognises the lock providers' contention errors", () => {
    expect(isLockBusy(new Error('Failed to acquire lock for key "print-trail:stock"'))).toBe(true)
    expect(isLockBusy(new MedusaError(MedusaError.Types.CONFLICT, 'Failed to acquire lock for key "print-trail:stock"'))).toBe(true)
    // A serialised workflow error.
    expect(isLockBusy({ message: 'Failed to acquire lock for key "print-trail:stock"' })).toBe(true)
    // locking-postgres's insert race.
    expect(isLockBusy(new Error('"print-trail:stock" is already locked.'))).toBe(true)
    expect(isLockBusy(new Error("boom"))).toBe(false)
    expect(isLockBusy(undefined)).toBe(false)
  })
})
