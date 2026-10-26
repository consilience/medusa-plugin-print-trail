import type { MedusaContainer, RemoteQueryFunction } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { updateInventoryLevelsWorkflow, updateProductVariantsWorkflow } from "@medusajs/medusa/core-flows"
import { PRINT_TRAIL_PROVIDER_ID } from "../../lib/lines"
import { resolveSku } from "../../lib/sku"
import {
  BACKORDER_MARKER_KEY,
  backorderMarkerValue,
  PRE_ORDER_FIELD_KEY,
  readBackorderMarker,
  type BackorderReason,
  type StockVariant,
} from "../../lib/stock"
import type { MetadataPage, PluginMetadata, StockCatalogue, StockContext } from "../../lib/stock-flow"
import { installedMetadataUpdateMode, patchVariantMetadata, type VariantMetadataStore } from "../../lib/variant-metadata"
import { PRINT_TRAIL_MODULE } from "../../modules/printTrail"
import type PrintTrailModuleService from "../../modules/printTrail/service"

// The paths core-flows reads for order items' inventory.
export const STOCK_VARIANT_FIELDS = [
  "id",
  "sku",
  "metadata",
  "manage_inventory",
  "allow_backorder",
  "product_id",
  "inventory_items.inventory_item_id",
  "inventory_items.required_quantity",
  "inventory_items.inventory.location_levels.location_id",
  "inventory_items.inventory.location_levels.stocked_quantity",
  "inventory_items.inventory.location_levels.reserved_quantity",
]

const PRODUCT_CHUNK = 200
const VARIANT_CHUNK = 100

type GraphStockVariant = {
  id: string
  sku?: string | null
  metadata?: Record<string, unknown> | null
  manage_inventory?: boolean | null
  allow_backorder?: boolean | null
  product_id?: string | null
  inventory_items?: ({
    inventory_item_id: string
    required_quantity?: number | string | null
    inventory?: {
      location_levels?: ({
        location_id: string
        stocked_quantity?: number | string | null
        reserved_quantity?: number | string | null
      } | null)[] | null
    } | null
  } | null)[] | null
}

export function toStockVariants(graphVariants: unknown[], profileByProduct: Map<string, string>): StockVariant[] {
  return (graphVariants as (GraphStockVariant | null)[]).flatMap((v) =>
    v
      ? [
          {
            id: v.id,
            sku: resolveSku(v),
            profileId: (v.product_id && profileByProduct.get(v.product_id)) || null,
            manageInventory: v.manage_inventory === true,
            allowBackorder: v.allow_backorder === true,
            backorderMarker: readBackorderMarker(v.metadata?.[BACKORDER_MARKER_KEY]),
            preOrderField: v.metadata?.[PRE_ORDER_FIELD_KEY],
            inventory: (v.inventory_items ?? []).flatMap((i) =>
              i
                ? [
                    {
                      inventoryItemId: i.inventory_item_id,
                      requiredQuantity: Number(i.required_quantity ?? 1),
                      levels: (i.inventory?.location_levels ?? []).flatMap((l) =>
                        l
                          ? [
                              {
                                locationId: l.location_id,
                                stockedQuantity: Number(l.stocked_quantity ?? 0),
                                reservedQuantity: Number(l.reserved_quantity ?? 0),
                              },
                            ]
                          : []
                      ),
                    },
                  ]
                : []
            ),
          },
        ]
      : []
  )
}

// Profiles with at least one live Print Trail shipping option (deleted
// options are excluded by default).
export async function loadPtProfileIds(query: Omit<RemoteQueryFunction, symbol>): Promise<string[]> {
  const { data } = await query.graph({
    entity: "shipping_option",
    fields: ["shipping_profile_id"],
    filters: { provider_id: PRINT_TRAIL_PROVIDER_ID },
  })
  return [...new Set(data.map((o) => o.shipping_profile_id as string).filter(Boolean))]
}

// product id → shipping profile id, from the product–shipping profile link.
export async function loadProfileByProduct(
  query: Omit<RemoteQueryFunction, symbol>,
  filter: { productIds?: string[]; profileIds?: string[] }
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const filters: Record<string, string[]> = {}
  if (filter.productIds) filters.product_id = filter.productIds
  if (filter.profileIds) filters.shipping_profile_id = filter.profileIds
  if (!Object.values(filters).every((ids) => ids.length)) {
    return map
  }
  const { data } = await query.graph({
    entity: "product_shipping_profile",
    fields: ["product_id", "shipping_profile_id"],
    filters,
  })
  for (const row of data as { product_id: string; shipping_profile_id: string }[]) {
    map.set(row.product_id, row.shipping_profile_id)
  }
  return map
}

// Medusa replaces variant metadata on update up to 2.18 and merges it from
// 2.19.0: see src/lib/variant-metadata.ts.
export function buildVariantMetadataStore(container: MedusaContainer): VariantMetadataStore {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  return {
    mode: installedMetadataUpdateMode(),
    async read(ids) {
      const { data } = await query.graph({ entity: "product_variant", fields: ["id", "metadata"], filters: { id: ids } })
      return data.map((v) => ({ id: v.id, metadata: (v.metadata as Record<string, unknown> | null) ?? null }))
    },
    async write(rows) {
      await updateProductVariantsWorkflow(container).run({ input: { product_variants: rows } })
    },
  }
}

// The marker is true for print-on-demand and "pre-order" for a pre-order
// product; "" deletes it (src/lib/variant-metadata.ts).
export function backorderPatches(variantIds: string[], on: boolean, reasonById?: Record<string, BackorderReason>) {
  return variantIds.map((id) => ({
    id,
    metadata: { [BACKORDER_MARKER_KEY]: on ? backorderMarkerValue(reasonById?.[id] ?? "print-on-demand") : "" },
    fields: { allow_backorder: on },
  }))
}

// print_trail_pre_order: the date, true, or "" to delete it. Skipped when the
// variant's current metadata already says the same (re-read just before).
export function preOrderFieldPatches(updates: { id: string; value: string | true | null }[]) {
  return updates.map(({ id, value }) => ({
    id,
    metadata: { [PRE_ORDER_FIELD_KEY]: value ?? "" },
    when: (current: Record<string, unknown> | null) => {
      const stored = current?.[PRE_ORDER_FIELD_KEY]
      return value === null ? stored !== undefined && stored !== null : stored !== value
    },
  }))
}

// The stale marker alone: "" deletes it, and allow_backorder isn't written.
// Skipped when the variant no longer has the key.
export function staleMarkerPatches(variantIds: string[]) {
  return variantIds.map((id) => ({
    id,
    metadata: { [BACKORDER_MARKER_KEY]: "" },
    when: (current: Record<string, unknown> | null) => current?.[BACKORDER_MARKER_KEY] !== undefined,
  }))
}

// One page of the metadata scan: up to `take` variants (soft-deleted ones
// excluded) with ids after `after`, by id ascending; only those carrying one
// of the stock sync's keys are kept. Keyset rather than offset, so a variant
// deleted from a page already read can't shift an unread one behind the
// next page's start. Postgres both compares and orders the ids, so the two
// agree. No skip, so Query calls the module's list, with no count.
export async function listPluginMetadata(
  query: Omit<RemoteQueryFunction, symbol>,
  after: string | null,
  take: number
): Promise<MetadataPage> {
  const { data } = await query.graph({
    entity: "product_variant",
    fields: ["id", "metadata"],
    ...(after === null ? {} : { filters: { id: { $gt: after } } }),
    pagination: { take, order: { id: "ASC" } },
  })
  const rows = data as { id: string; metadata?: Record<string, unknown> | null }[]
  const found: PluginMetadata[] = []
  for (const v of rows) {
    const preOrderField = v.metadata?.[PRE_ORDER_FIELD_KEY]
    const backorderMarker = readBackorderMarker(v.metadata?.[BACKORDER_MARKER_KEY])
    if ((preOrderField !== undefined && preOrderField !== null) || backorderMarker !== null) {
      found.push({ id: v.id, preOrderField, backorderMarker })
    }
  }
  return { found, lastId: rows.length ? rows[rows.length - 1].id : null, read: rows.length }
}

export function buildStockCatalogue(container: MedusaContainer): StockCatalogue {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const metadata = buildVariantMetadataStore(container)
  return {
    ptProfileIds: () => loadPtProfileIds(query),
    async loadVariants(ptProfileIds) {
      const profileByProduct = await loadProfileByProduct(query, { profileIds: ptProfileIds })
      const productIds = [...profileByProduct.keys()]
      const variants: StockVariant[] = []
      for (let i = 0; i < productIds.length; i += PRODUCT_CHUNK) {
        const { data } = await query.graph({
          entity: "product_variant",
          fields: STOCK_VARIANT_FIELDS,
          filters: { product_id: productIds.slice(i, i + PRODUCT_CHUNK), manage_inventory: true },
        })
        variants.push(...toStockVariants(data, profileByProduct))
      }
      return variants
    },
    async updateLevels(updates) {
      await updateInventoryLevelsWorkflow(container).run({ input: { updates } })
    },
    // One update per variant, so allow_backorder and the marker never
    // disagree. Turning it off deletes the marker and keeps the other keys.
    // The flow only switches off variants in its stock_backordered record.
    async setBackorder(variantIds, on, reasonById) {
      for (let i = 0; i < variantIds.length; i += VARIANT_CHUNK) {
        await patchVariantMetadata(metadata, backorderPatches(variantIds.slice(i, i + VARIANT_CHUNK), on, reasonById))
      }
    },
    async setPreOrderFields(updates) {
      for (let i = 0; i < updates.length; i += VARIANT_CHUNK) {
        await patchVariantMetadata(metadata, preOrderFieldPatches(updates.slice(i, i + VARIANT_CHUNK)))
      }
    },
    async clearBackorderMarkers(variantIds) {
      for (let i = 0; i < variantIds.length; i += VARIANT_CHUNK) {
        await patchVariantMetadata(metadata, staleMarkerPatches(variantIds.slice(i, i + VARIANT_CHUNK)))
      }
    },
    listPluginMetadata: (after, take) => listPluginMetadata(query, after, take),
  }
}

export async function buildStockContext(container: MedusaContainer): Promise<StockContext> {
  const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  return {
    client: await service.getClient(),
    state: service,
    catalogue: buildStockCatalogue(container),
    options: await service.getOptions(),
    seen: service,
    logger: container.resolve(ContainerRegistrationKeys.LOGGER),
  }
}
