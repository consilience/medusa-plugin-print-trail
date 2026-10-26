// Print Trail API shapes, as served (API 1.0.0, plus API 1.1.0's confirmedAt
// and webhookDetail.secret, and API 1.3.0's backOrderReason,
// sentToWarehouseAt and pre-order stock fields). The published OpenAPI
// document is the reference.

export type PtAddress = {
  companyName?: string
  address1?: string
  address2?: string
  address3?: string
  address4?: string
  locality?: string
  city?: string
  postalCode?: string
  state?: { name?: string; code?: string }
  country?: { name?: string; code?: string }
}

export type PtContact = {
  firstName?: string
  lastName?: string
  mobile?: string
  phone?: string
  email?: string
}

export type PtShippingDetails = {
  postalAddress?: PtAddress
  deliveryContact?: PtContact
  note?: string
}

export type PtProductRef = { sku?: string; uuid?: string; isbn?: string }

export type PtOrderLineInput = {
  quantity: number
  lineNumber: string
  product: PtProductRef
}

export type PtCreateOrderRequest = {
  orderNumber: string
  orderLines: PtOrderLineInput[]
  uuid?: string
  reserve?: boolean
  strictSkus?: boolean
  printTrailOrderNumber?: string
  purchaseOrder?: string
  orderUrl?: string
  requestedShippingMethod?: string
  shippingDetails?: PtShippingDetails
}

export type PtConfirmRequest = {
  defaultShippingMethod?: string
  fulfilmentShippingMethods?: { fulfilmentUuid: string; shippingMethod: string }[]
}

export type PtLinesRequest = {
  orderLines: { lineNumber: string; quantity: number; product?: PtProductRef }[]
}

export type PtTrackingDetail = {
  carrier?: string | null
  trackingNumber?: string | null
  trackingUrl?: string | null
  methodName?: string | null
  shippedAt?: string | null
  // Legacy duplicates of carrier/trackingNumber/trackingUrl.
  courier?: string | null
  number?: string | null
  url?: string | null
}

export type PtShippingMethod = { code: string | null; name: string | null }

export type PtOrderLine = {
  uuid?: string
  quantity: number
  lineNumber: string | null
  fulfilmentUuid?: string | null
  product?: PtLineProduct | null
}

export type PtProductStatus = "active" | "inactive" | "pre-order"

// orderLines[].product (Print Trail's product resource). activeState is
// older than API 1.3.0; the rest arrive with it. Absent keys: nothing can be
// read.
export type PtLineProduct = {
  uuid?: string
  sku?: string | null
  activeState?: PtProductStatus | string | null
  publicationDate?: string | null
  preOrderLimit?: number | null
  preOrderRemaining?: number | null
  [k: string]: unknown
}

// API 1.3.0: why a back-order fulfilment waits. pre-order / out-of-stock: held
// by Print Trail; warehouse: sent, and the warehouse reports a back-order.
export type PtBackOrderReason = "pre-order" | "out-of-stock" | "warehouse"

export type PtFulfilment = {
  uuid: string
  fulfilmentNumber?: string | null
  productionMethod?: string | null
  supplierLocation?: { code?: string | null; name?: string | null } | null
  status: string
  orderLines?: PtOrderLine[]
  availableShippingMethods?: PtShippingMethod[]
  requestedShippingMethod?: string | null
  trackingDetails?: PtTrackingDetail[]
  // API 1.3.0. Absent (undefined) from an older Print Trail API.
  backOrderReason?: PtBackOrderReason | string | null
  // API 1.3.0: when the warehouse accepted the fulfilment; null while Print
  // Trail holds it.
  sentToWarehouseAt?: string | null
}

export type PtOrderError = {
  code?: string | null
  key?: string | null
  message?: string | null
}

export type PtOrder = {
  uuid: string
  orderNumber?: string | null
  printTrailOrderNumber?: string | null
  purchaseOrder?: string | null
  status: string
  fulfillableStatus?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  reservationsExpireAt?: string | null
  fulfillableFrom?: string | null
  scheduledAt?: string | null
  // API 1.1.0: when Print Trail first confirmed the order, or null (a draft,
  // including one taken back to draft). Absent (undefined) from an older
  // Print Trail API: then nothing can be read from it.
  confirmedAt?: string | null
  shippingDetails?: PtShippingDetails | null
  orderLines?: PtOrderLine[]
  fulfilments?: PtFulfilment[]
  errors?: PtOrderError[]
}

export type PtAmendment = {
  result: "amended" | "unchanged"
  message?: string
  changes?: {
    lineNumber: string
    change: "quantity_changed" | "removed" | "added"
    from: number
    to: number
    sku?: string | null
  }[]
  status?: string
  requeued?: boolean
  fulfillableFrom?: string | null
  scheduledAt?: string | null
}

export type PtChannel = {
  id: number
  name: string
  state?: string
  mode?: string
  lastSyncedAt?: string | null
  // secret: only in the POST /webhooks and rotate responses (API 1.1.0).
  // The client strips it before returning a channel.
  webhookDetail?: { uri: string | null; secret?: string } | null
  code: string
  team?: { name: string; code: string; returnsPolicyUrl?: string | null } | null
}

export type PtToken = { teamCode: string; channelCode: string; channelId: string }

export type PtSkuResult = {
  sku: string
  state: "matched" | "unknown"
  matchedSku?: string
  uuid?: string
  status?: "active" | "inactive" | "pre-order"
}

export type PtSkuValidation = {
  results: PtSkuResult[]
  summary: { matched: number; unknown: number }
}

export type PtStockLevel = {
  sku: string | null
  stock: number
  // API 1.3.0. Absent from an older Print Trail API.
  status?: PtProductStatus | null
  publicationDate?: string | null
  preOrderLimit?: number | null
  preOrderRemaining?: number | null
}

// One stock-level-updated item.
export type PtStockWebhookItem = PtStockLevel & { productUuid?: string }

export type PtWebhookPayload = {
  notificationType: string
  tenantCode?: string
  channelCode?: string
  message?: string
  orderUuid?: string
  orderNumber?: string
  createdAt?: string
  updatedAt?: string
  confirmedAt?: string | null
  changedAt?: string
  // stock-level-updated: PtStockWebhookItem objects; fulfilment-status-updated:
  // SKU strings.
  products?: unknown[]
  // fulfilment-status-updated (API 1.3.0). Read for logging only: the receiver
  // re-fetches the order.
  backOrderReason?: string | null
  sentToWarehouseAt?: string | null
  [k: string]: unknown
}
