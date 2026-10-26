import {
  installedMetadataUpdateMode,
  mergeVariantMetadata,
  metadataUpdateModeFor,
  patchVariantMetadata,
} from "../variant-metadata"

describe("mergeVariantMetadata", () => {
  it("keeps other keys, sets the patch and deletes keys patched with an empty string", () => {
    expect(mergeVariantMetadata({ print_trail_sku: "PT-1", print_trail_backorder: true, other: 1 }, { print_trail_backorder: "" })).toEqual({
      print_trail_sku: "PT-1",
      other: 1,
    })
    expect(mergeVariantMetadata(null, { a: { b: 1 } })).toEqual({ a: { b: 1 } })
  })

  it("writes a numeric print_trail_sku back as a string", () => {
    expect(mergeVariantMetadata({ print_trail_sku: 9780000000026 }, { print_trail_sku_check: {} })).toEqual({
      print_trail_sku: "9780000000026",
      print_trail_sku_check: {},
    })
  })

  // Medusa 2.19+ merges the update into the stored metadata, so a key left
  // out would be kept; "" deletes it.
  it("writes a deleted key as an empty string when Medusa merges", () => {
    expect(
      mergeVariantMetadata({ print_trail_sku: "PT-1", print_trail_backorder: true, other: 1 }, { print_trail_backorder: "" }, "merge")
    ).toEqual({ print_trail_sku: "PT-1", print_trail_backorder: "", other: 1 })
    // Nothing to delete: nothing written for it.
    expect(mergeVariantMetadata({ other: 1 }, { print_trail_backorder: "", constructor: "" }, "merge")).toEqual({ other: 1 })
    expect(mergeVariantMetadata({ print_trail_sku: 9780000000026 }, { print_trail_pre_order: true }, "merge")).toEqual({
      print_trail_sku: "9780000000026",
      print_trail_pre_order: true,
    })
  })
})

describe("metadataUpdateModeFor", () => {
  it("replaces before Medusa 2.19.0 and merges from it", () => {
    expect(metadataUpdateModeFor("2.17.2")).toBe("replace")
    expect(metadataUpdateModeFor("2.18.0")).toBe("replace")
    expect(metadataUpdateModeFor("2.19.0")).toBe("merge")
    expect(metadataUpdateModeFor("2.19.0-snapshot-20260801")).toBe("merge")
    expect(metadataUpdateModeFor("2.22.1")).toBe("merge")
    expect(metadataUpdateModeFor("3.0.0")).toBe("merge")
  })

  it("assumes the current behaviour when the version is unknown", () => {
    expect(metadataUpdateModeFor(undefined)).toBe("merge")
    expect(metadataUpdateModeFor("")).toBe("merge")
    expect(metadataUpdateModeFor("next")).toBe("merge")
  })

  it("reads the installed @medusajs/medusa", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { version } = require("@medusajs/medusa/package.json") as { version: string }
    expect(installedMetadataUpdateMode()).toBe(metadataUpdateModeFor(version))
  })
})

describe("patchVariantMetadata", () => {
  // Medusa before 2.19 replaces variant metadata on update (upsertWithReplace,
  // no mergeMetadata), so the plugin merges first.
  it("writes the variant's whole metadata with only the plugin's keys changed", async () => {
    const stored: Record<string, Record<string, unknown> | null> = {
      v1: { print_trail_sku: "PT-1", note: "x" },
      v2: null,
    }
    const writes: unknown[] = []
    await patchVariantMetadata(
      {
        read: async (ids) => ids.filter((id) => id in stored).map((id) => ({ id, metadata: stored[id] })),
        write: async (rows) => {
          writes.push(...rows)
        },
      },
      [
        { id: "v1", metadata: { print_trail_backorder: true }, fields: { allow_backorder: true } },
        { id: "v2", metadata: { print_trail_backorder: "" }, fields: { allow_backorder: false } },
        { id: "v_gone", metadata: { print_trail_backorder: true } },
      ]
    )
    expect(writes).toEqual([
      { id: "v1", allow_backorder: true, metadata: { print_trail_sku: "PT-1", note: "x", print_trail_backorder: true } },
      { id: "v2", allow_backorder: false, metadata: {} },
    ])
  })
})

describe("patchVariantMetadata on a Medusa that merges", () => {
  it("writes the whole metadata with deleted keys as empty strings", async () => {
    const writes: unknown[] = []
    await patchVariantMetadata(
      {
        mode: "merge",
        read: async () => [
          { id: "v1", metadata: { print_trail_sku: "PT-1", print_trail_backorder: "pre-order", print_trail_pre_order: "2026-12-01" } },
          { id: "v2", metadata: null },
        ],
        write: async (rows) => {
          writes.push(...rows)
        },
      },
      [
        { id: "v1", metadata: { print_trail_backorder: "", print_trail_pre_order: "" }, fields: { allow_backorder: false } },
        { id: "v2", metadata: { print_trail_backorder: "" }, fields: { allow_backorder: false } },
      ]
    )
    expect(writes).toEqual([
      { id: "v1", allow_backorder: false, metadata: { print_trail_sku: "PT-1", print_trail_backorder: "", print_trail_pre_order: "" } },
      { id: "v2", allow_backorder: false, metadata: {} },
    ])
  })
})

describe("patchVariantMetadata with a condition", () => {
  it("skips variants whose current metadata fails the condition", async () => {
    const writes: { id: string }[] = []
    await patchVariantMetadata(
      {
        read: async () => [
          { id: "v1", metadata: { print_trail_backorder: true } },
          { id: "v2", metadata: { note: "merchant cleared the marker" } },
        ],
        write: async (rows) => {
          writes.push(...rows)
        },
      },
      ["v1", "v2"].map((id) => ({
        id,
        metadata: { print_trail_backorder: "" },
        fields: { allow_backorder: false },
        when: (m: Record<string, unknown> | null) => m?.print_trail_backorder === true,
      }))
    )
    expect(writes.map((w) => w.id)).toEqual(["v1"])
  })
})
