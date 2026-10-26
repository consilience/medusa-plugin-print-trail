import { PostPrintTrailShippingOptionSchema, UpdatePrintTrailShippingOptionSchema } from "../shipping-options/validators"

const body = (currency_code: string) => ({
  name: "UK",
  service_zone_id: "serzo_1",
  shipping_profile_id: "sp_1",
  rate_card: { method: "tracked", currency_code, bands: [{ max_weight: null, prices: { gbp: 1 } }] },
})

describe("rate-card route validators", () => {
  it("need a three-letter currency code", () => {
    expect(PostPrintTrailShippingOptionSchema.safeParse(body("GBP")).success).toBe(true)
    expect(PostPrintTrailShippingOptionSchema.safeParse(body("gbpx")).success).toBe(false)
    expect(PostPrintTrailShippingOptionSchema.safeParse(body("g1p")).success).toBe(false)
    expect(UpdatePrintTrailShippingOptionSchema.safeParse({ rate_card: body("gbpx").rate_card }).success).toBe(false)
  })

  // Zod objects drop unknown keys: without countries in the route schema,
  // saving the default bands would lose every country's.
  it("keep a card's countries for the route", () => {
    const countries = { fr: [{ max_weight: 2000, prices: { gbp: 8.25 } }] }
    const card = { ...body("gbp").rate_card, countries }
    const created = PostPrintTrailShippingOptionSchema.parse({ ...body("gbp"), rate_card: card })
    expect(created.rate_card.countries).toEqual(countries)
    const updated = UpdatePrintTrailShippingOptionSchema.parse({ rate_card: card })
    expect(updated.rate_card?.countries).toEqual(countries)
    expect(UpdatePrintTrailShippingOptionSchema.parse({ rate_card: body("gbp").rate_card }).rate_card).not.toHaveProperty("countries")
    expect(UpdatePrintTrailShippingOptionSchema.safeParse({ rate_card: { ...card, countries: { fr: "x" } } }).success).toBe(false)
    expect(UpdatePrintTrailShippingOptionSchema.parse({ rate_card: { ...card, countries: { de: null } } }).rate_card?.countries).toEqual({ de: null })
  })
})
