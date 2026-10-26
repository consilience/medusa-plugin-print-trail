// Builds the harness store with core-flows workflows: a GBP region, a sales
// channel and publishable key, one stock location with a fulfilment set, a
// Print Trail profile and option (with a rate card) and a manual option on the
// default profile, and seven products.
import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  createApiKeysWorkflow,
  createInventoryLevelsWorkflow,
  createProductsWorkflow,
  createRegionsWorkflow,
  createSalesChannelsWorkflow,
  createShippingOptionsWorkflow,
  createShippingProfilesWorkflow,
  createStockLocationsWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
  updateStoresWorkflow,
} from "@medusajs/medusa/core-flows"
import { SKUS } from "../harness"

export type Seed = {
  regionId: string
  salesChannelId: string
  publishableKey: string
  stockLocationId: string
  ptProfileId: string
  defaultProfileId: string
  ptOptionId: string
  manualOptionId: string
  variants: { pt: string; pt2: string; ptZero: string; pod: string; preOrder: string; unknownSku: string; plain: string }
}

export const RATE_CARD = {
  method: "tracked",
  currency_code: "gbp",
  bands: [
    { max_weight: 1000, prices: { gbp: 3.95 } },
    { max_weight: null, prices: { gbp: 6.5 } },
  ],
}

const ruleSet = [
  { attribute: "enabled_in_store", value: "true", operator: "eq" as const },
  { attribute: "is_return", value: "false", operator: "eq" as const },
]

export async function seedStore(container: MedusaContainer): Promise<Seed> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const link = container.resolve(ContainerRegistrationKeys.LINK)
  const fulfillment = container.resolve(Modules.FULFILLMENT)

  const {
    result: [salesChannel],
  } = await createSalesChannelsWorkflow(container).run({
    input: { salesChannelsData: [{ name: "Harness store" }] },
  })

  const { data: stores } = await query.graph({ entity: "store", fields: ["id"] })
  await updateStoresWorkflow(container).run({
    input: {
      selector: { id: stores[0].id },
      update: {
        supported_currencies: [{ currency_code: "gbp", is_default: true }],
        default_sales_channel_id: salesChannel.id,
      },
    },
  })

  const {
    result: [region],
  } = await createRegionsWorkflow(container).run({
    input: {
      regions: [{ name: "United Kingdom", currency_code: "gbp", countries: ["gb"], payment_providers: ["pp_system_default"] }],
    },
  })

  const {
    result: [apiKey],
  } = await createApiKeysWorkflow(container).run({
    input: { api_keys: [{ title: "Harness storefront", type: "publishable", created_by: "" }] },
  })
  await linkSalesChannelsToApiKeyWorkflow(container).run({ input: { id: apiKey.id, add: [salesChannel.id] } })

  const {
    result: [location],
  } = await createStockLocationsWorkflow(container).run({
    input: { locations: [{ name: "Harness warehouse", address: { address_1: "1 Dock Road", city: "London", country_code: "gb" } }] },
  })
  await linkSalesChannelsToStockLocationWorkflow(container).run({ input: { id: location.id, add: [salesChannel.id] } })
  for (const providerId of ["manual_manual", "print-trail_print-trail"]) {
    await link.create({
      [Modules.STOCK_LOCATION]: { stock_location_id: location.id },
      [Modules.FULFILLMENT]: { fulfillment_provider_id: providerId },
    })
  }

  // Dispatch creates Medusa fulfilments, which need a stock location on the
  // option's fulfilment set.
  const fulfillmentSet = await fulfillment.createFulfillmentSets({
    name: "Harness shipping",
    type: "shipping",
    service_zones: [{ name: "United Kingdom", geo_zones: [{ country_code: "gb", type: "country" }] }],
  })
  await link.create({
    [Modules.STOCK_LOCATION]: { stock_location_id: location.id },
    [Modules.FULFILLMENT]: { fulfillment_set_id: fulfillmentSet.id },
  })
  const serviceZoneId = fulfillmentSet.service_zones[0].id

  const { data: defaults } = await query.graph({
    entity: "shipping_profile",
    fields: ["id"],
    filters: { type: "default" },
  })
  let defaultProfileId = defaults[0]?.id as string | undefined
  if (!defaultProfileId) {
    const { result } = await createShippingProfilesWorkflow(container).run({
      input: { data: [{ name: "Default", type: "default" }] },
    })
    defaultProfileId = result[0].id
  }
  const {
    result: [ptProfile],
  } = await createShippingProfilesWorkflow(container).run({
    input: { data: [{ name: "Print Trail", type: "print-trail" }] },
  })

  const { result: options } = await createShippingOptionsWorkflow(container).run({
    input: [
      {
        name: "Print Trail Tracked",
        price_type: "calculated",
        provider_id: "print-trail_print-trail",
        service_zone_id: serviceZoneId,
        shipping_profile_id: ptProfile.id,
        type: { label: "Tracked", description: "Sent by Print Trail", code: "print-trail-tracked" },
        data: RATE_CARD,
        prices: [],
        rules: ruleSet,
      },
      {
        name: "Standard",
        price_type: "flat",
        provider_id: "manual_manual",
        service_zone_id: serviceZoneId,
        shipping_profile_id: defaultProfileId,
        type: { label: "Standard", description: "Posted by the shop", code: "standard" },
        prices: [{ currency_code: "gbp", amount: 2 }, { region_id: region.id, amount: 2 }],
        rules: ruleSet,
      },
    ] as any,
  })
  const ptOption = options.find((o: any) => o.provider_id === "print-trail_print-trail")!
  const manualOption = options.find((o: any) => o.provider_id === "manual_manual")!

  const product = (key: string, title: string, sku: string, profileId: string) => ({
    title,
    handle: `harness-${key.toLowerCase()}`,
    status: "published" as const,
    weight: 400,
    shipping_profile_id: profileId,
    sales_channels: [{ id: salesChannel.id }],
    options: [{ title: "Format", values: ["Paperback"] }],
    variants: [
      {
        title: `${title} paperback`,
        sku,
        weight: 400,
        manage_inventory: true,
        options: { Format: "Paperback" },
        prices: [{ currency_code: "gbp", amount: 10 }],
      },
    ],
  })
  const { result: products } = await createProductsWorkflow(container).run({
    input: {
      products: [
        product("pt", "Harness Book", SKUS.pt, ptProfile.id),
        product("pt2", "Harness Book Two", SKUS.pt2, ptProfile.id),
        product("ptZero", "Harness Book Out Of Stock", SKUS.ptZero, ptProfile.id),
        product("pod", "Harness Book On Demand", SKUS.pod, ptProfile.id),
        // Managed inventory, backorders off: the stock sync turns them on
        // while Print Trail has it on pre-order.
        product("preOrder", "Harness Book Pre-order", SKUS.preOrder, ptProfile.id),
        product("unknownSku", "Harness Book Unknown", SKUS.unknownSku, ptProfile.id),
        product("plain", "Harness Bookmark", "HAR-PLAIN", defaultProfileId),
      ],
    },
  })
  const variantOf = (handle: string) => products.find((p: any) => p.handle === handle)!.variants[0].id as string

  const { data: items } = await query.graph({ entity: "inventory_item", fields: ["id"] })
  await createInventoryLevelsWorkflow(container).run({
    input: {
      inventory_levels: items.map((item: any) => ({
        inventory_item_id: item.id,
        location_id: location.id,
        stocked_quantity: 100,
      })),
    },
  })

  await settleSkuChecks(container)

  return {
    regionId: region.id,
    salesChannelId: salesChannel.id,
    publishableKey: apiKey.token,
    stockLocationId: location.id,
    ptProfileId: ptProfile.id,
    defaultProfileId,
    ptOptionId: ptOption.id,
    manualOptionId: manualOption.id,
    variants: {
      pt: variantOf("harness-pt"),
      pt2: variantOf("harness-pt2"),
      ptZero: variantOf("harness-ptzero"),
      pod: variantOf("harness-pod"),
      preOrder: variantOf("harness-preorder"),
      unknownSku: variantOf("harness-unknownsku"),
      plain: variantOf("harness-plain"),
    },
  }
}

// Product and variant saves queue SKU checks that drain a second later. Wait
// for the queue to empty, so the runner's database snapshot (taken before the
// first test) doesn't cut off a drain mid-query.
export async function settleSkuChecks(container: MedusaContainer, timeoutMs = 15_000): Promise<void> {
  const service = container.resolve("printTrail") as any
  const deadline = Date.now() + timeoutMs
  await new Promise((r) => setTimeout(r, 1500))
  while (Date.now() < deadline) {
    const rows: { key: string }[] = await service.listPrintTrailStates({}, { select: ["key"] })
    if (!rows.some((r) => r.key.startsWith("sku_check:"))) break
    await new Promise((r) => setTimeout(r, 200))
  }
  // The drain's own writes (results, follow-ups) finish after the queue empties.
  await new Promise((r) => setTimeout(r, 500))
}

// Soft-deletes a variant in the database, with no workflow, so no
// product-variant.deleted event fires: as a store's own script might.
export async function softDeleteVariantQuietly(dbConnection: any, variantId: string): Promise<void> {
  await dbConnection.raw(`update product_variant set deleted_at = now() where id = ?`, [variantId])
}
