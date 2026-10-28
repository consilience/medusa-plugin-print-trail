import { AbstractFulfillmentProviderService, MedusaError } from "@medusajs/framework/utils"
import type {
  CalculatedShippingOptionPrice,
  CalculateShippingOptionPriceDTO,
  CreateFulfillmentResult,
  FulfillmentOption,
  Logger,
  ValidateFulfillmentDataContext,
} from "@medusajs/framework/types"
import { isConnected, resolveCredentials, type PrintTrailCredentials } from "../../config"
import { bandsFor, cartWeight, countryName, FALLBACK_METHODS, priceForWeight, rateCardSchema } from "../../lib/rate-card"
import { PrintTrailClient } from "../../modules/printTrail/client/client"
import { isCartOptionListing } from "./pricing-context"

// The Print Trail fulfilment provider: fulfilment options and rate-card
// prices only. Orders are sent by the plugin's workflows, not from here, and
// Medusa fulfilments are created only when Print Trail dispatches, so
// createFulfillment is a no-op.
export class PrintTrailFulfillmentService extends AbstractFulfillmentProviderService {
  static identifier = "print-trail"

  protected readonly logger_: Logger
  protected readonly options_: PrintTrailCredentials
  private client_?: PrintTrailClient

  constructor({ logger }: { logger: Logger }, options: PrintTrailCredentials) {
    super()
    this.logger_ = logger
    this.options_ = resolveCredentials(options)
  }

  // The provider lives in the Fulfillment Module's container and can't resolve
  // the printTrail module, so it builds its own small client.
  private get client(): PrintTrailClient | null {
    if (!isConnected(this.options_)) {
      return null
    }
    this.client_ ??= new PrintTrailClient({
      baseUrl: this.options_.baseUrl!,
      channelId: this.options_.channelId!,
      apiToken: this.options_.apiToken!,
      retryDelays: [500],
    })
    return this.client_
  }

  async getFulfillmentOptions(): Promise<FulfillmentOption[]> {
    const fallback = FALLBACK_METHODS.map((code) => ({ id: code, name: code, method: code }))
    const client = this.client
    if (!client) {
      return fallback
    }
    try {
      const methods = await client.listShippingMethods()
      const options = methods
        .filter((m) => m.code)
        .map((m) => ({ id: m.code!, name: m.name ?? m.code!, method: m.code! }))
      return options.length ? options : fallback
    } catch (e) {
      this.logger_.warn(
        `Print Trail API: couldn't load shipping methods, offering the defaults (${(e as Error).message})`
      )
      return fallback
    }
  }

  // Medusa doesn't call this on shipping-option create or update; the plugin's
  // admin routes and middleware validate rate cards instead. Kept for any
  // caller that does.
  async validateOption(data: Record<string, unknown>): Promise<boolean> {
    const method = typeof data?.method === "string" ? data.method : ""
    const result = rateCardSchema(method ? [method] : FALLBACK_METHODS).safeParse(data)
    if (!result.success) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Invalid Print Trail rate card: ${result.error.issues.map((i) => i.message).join("; ")}`
      )
    }
    return true
  }

  async validateFulfillmentData(
    optionData: Record<string, unknown>,
    data: Record<string, unknown>,
    _context: ValidateFulfillmentDataContext
  ): Promise<Record<string, unknown>> {
    return { ...data, method: optionData.method }
  }

  async canCalculate(): Promise<boolean> {
    return true
  }

  async calculatePrice(
    optionData: CalculateShippingOptionPriceDTO["optionData"],
    _data: CalculateShippingOptionPriceDTO["data"],
    context: CalculateShippingOptionPriceDTO["context"]
  ): Promise<CalculatedShippingOptionPrice> {
    await this.validateOption(optionData)
    const card = rateCardSchema([String(optionData.method)]).parse(optionData)
    // The cart's currency where the context has one (the option listing;
    // /store/shipping-options/:id/calculate from Medusa 2.19.0), else the
    // card's (/calculate before 2.19, an order's or a draft order's option).
    const currency = String(
      (context as { currency_code?: string }).currency_code || card.currency_code
    )
    const { grams, missing } = cartWeight((context.items ?? []) as never[])
    if (missing.length) {
      this.logger_.warn(
        `Print Trail shipping: ${missing.length} item(s) without a weight counted as 0 g`
      )
    }
    // The destination picks the card's band list. Every path that prices a
    // calculated option (the cart's option list, adding a shipping method,
    // /store/shipping-options/:id/calculate, an order's own options) puts
    // the cart's or order's shipping_address in the context (2.17.2 to
    // 2.22.1, and a draft order's from 2.20). No address yet, or no country:
    // the default bands.
    const country = context.shipping_address?.country_code?.toLowerCase() || null
    const amount = priceForWeight(card, grams, currency, country)
    if (amount === null) {
      // Above the last band (a 2 kg limit abroad, say): checkout
      // can't use the option.
      const to = country && bandsFor(card, country) !== card.bands ? ` to ${countryName(country)}` : ""
      const reason = `No ${card.method} rate for ${grams} g${to} in ${currency.toUpperCase()}`
      if (isCartOptionListing(context)) {
        // Adding a method or the cart refresh: no price, so Medusa refuses
        // the add and drops a chosen method; a throw here would fail the
        // whole cart update, so an item past the cap couldn't be added.
        this.logger_.info(`Print Trail shipping: ${reason}; the option has no price for this cart`)
        return { is_calculated_price_tax_inclusive: false } as CalculatedShippingOptionPrice
      }
      // /store/shipping-options/:id/calculate, or anything not surely the
      // listing: refuse, so the option can never show as free.
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, reason)
    }
    return { calculated_amount: amount, is_calculated_price_tax_inclusive: false }
  }

  async createFulfillment(): Promise<CreateFulfillmentResult> {
    return { data: {}, labels: [] }
  }

  async cancelFulfillment(): Promise<Record<string, unknown>> {
    return {}
  }

  async createReturnFulfillment(): Promise<CreateFulfillmentResult> {
    // Print Trail has no returns API.
    return { data: {}, labels: [] }
  }
}

export default PrintTrailFulfillmentService
