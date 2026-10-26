import type { PtCreateOrderRequest, PtOrderLineInput } from "../modules/printTrail/client/types"

export type Address = {
  company?: string | null
  first_name?: string | null
  last_name?: string | null
  address_1?: string | null
  address_2?: string | null
  city?: string | null
  province?: string | null
  postal_code?: string | null
  country_code?: string | null
  phone?: string | null
}

export type PayloadLine = { lineItemId: string; sku: string | null; quantity: number }

export type PayloadInput = {
  orderNumber: string
  uuid?: string
  strictSkus: boolean
  shippingAddress?: Address | null
  billingAddress?: Address | null
  email?: string | null
  note?: string | null
  orderUrl?: string
  lines: PayloadLine[]
}

export type PayloadResult =
  | { ok: true; payload: PtCreateOrderRequest }
  | { ok: false; reason: "address-incomplete" | "no-pt-lines"; detail: string }

const NOTE_LIMIT = 500

const clip = (value: string | null | undefined, max: number) => {
  const v = (value ?? "").trim()
  return v ? Array.from(v).slice(0, max).join("") : undefined
}

// Print Trail barely validates addresses, so the plugin enforces its own
// minimum: country, address 1, city or postcode, and a name or company.
const isUsable = (a?: Address | null): a is Address =>
  !!a &&
  !!a.country_code?.trim() &&
  !!a.address_1?.trim() &&
  !!(a.city?.trim() || a.postal_code?.trim()) &&
  !!(a.first_name?.trim() || a.last_name?.trim() || a.company?.trim())

// "GB-ENG" → "ENG", "CA" → "CA"; anything longer is a name, not a code.
const stateCode = (province?: string | null) => {
  const code = (province ?? "").trim().replace(/^[a-z]{2}-/i, "")
  return /^[a-z]{1,3}$/i.test(code) ? code.toUpperCase() : undefined
}

export type ShippingDetailsResult =
  | { ok: true; shippingDetails: NonNullable<PtCreateOrderRequest["shippingDetails"]> }
  | { ok: false; reason: "address-incomplete"; detail: string }

export function buildShippingDetails(
  input: Pick<PayloadInput, "shippingAddress" | "billingAddress" | "email" | "note">
): ShippingDetailsResult {
  // Whole-group fallback: a usable billing address replaces the shipping
  // address entirely. Fields are never mixed from the two.
  const address = isUsable(input.shippingAddress)
    ? input.shippingAddress
    : isUsable(input.billingAddress)
      ? input.billingAddress
      : null
  if (!address) {
    return {
      ok: false,
      reason: "address-incomplete",
      detail:
        "The delivery address needs a country, address line 1, a city or postcode, and a name",
    }
  }
  const province = clip(address.province, 100)
  const code = stateCode(address.province)
  return {
    ok: true,
    shippingDetails: {
      postalAddress: {
        companyName: clip(address.company, 100),
        address1: clip(address.address_1, 100),
        address2: clip(address.address_2, 100),
        city: clip(address.city, 100),
        postalCode: clip(address.postal_code, 20),
        ...(province ? { state: code ? { name: province, code } : { name: province } } : {}),
        country: { code: address.country_code!.trim().toUpperCase() },
      },
      deliveryContact: {
        firstName: clip(address.first_name, 100),
        lastName: clip(address.last_name, 100),
        phone: clip(address.phone, 50),
        email: clip(input.email, 255),
      },
      note: clip(input.note, NOTE_LIMIT),
    },
  }
}

export function buildCreatePayload(input: PayloadInput): PayloadResult {
  const details = buildShippingDetails(input)
  if (!details.ok) {
    return details
  }

  const orderLines: PtOrderLineInput[] = input.lines
    // A fractional quantity stays in, for the send's whole-number check.
    .filter((l) => l.sku && l.quantity > 0)
    .map((l) => ({
      quantity: l.quantity,
      lineNumber: l.lineItemId,
      product: { sku: l.sku as string },
    }))
  if (!orderLines.length) {
    return { ok: false, reason: "no-pt-lines", detail: "No Print Trail lines to send" }
  }

  const payload: PtCreateOrderRequest = {
    orderNumber: input.orderNumber,
    // Stock is reserved by confirm; create-time reservations expire in minutes.
    reserve: false,
    strictSkus: input.strictSkus,
    ...(input.uuid ? { uuid: input.uuid } : {}),
    ...(input.orderUrl ? { orderUrl: input.orderUrl } : {}),
    shippingDetails: details.shippingDetails,
    orderLines,
  }
  return { ok: true, payload }
}
