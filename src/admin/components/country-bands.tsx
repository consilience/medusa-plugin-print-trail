import { Button, Text } from "@medusajs/ui"
import { useTranslation } from "react-i18next"
import type { RateCardDto } from "../../lib/admin-types"
import { formatPrice } from "../lib/format"
import { countryLabel, describeCountries } from "../lib/rate-card-form"

type Props = {
  card: RateCardDto
  // In the edit drawer: remove a country (also how an invalid one is repaired).
  onRemove?: (code: string) => void
  disabled?: boolean
  open?: boolean
}

// A rate card's per-country bands, collapsed: a card can list a hundred or
// more countries. The bands themselves are read-only.
export const CountryBands = ({ card, onRemove, disabled, open }: Props) => {
  const { t, i18n } = useTranslation("printTrail")
  const countries = describeCountries(card)
  if (!countries.length) return null
  const currency = card.currency_code
  return (
    <details className="mt-1" open={open}>
      <summary className="txt-compact-xsmall text-ui-fg-interactive cursor-pointer select-none">
        {t("shipping.countriesCount", { count: countries.length })}
      </summary>
      <div className="mt-1 flex flex-col gap-y-1">
        {countries.map((c) => (
          <div key={c.code}>
            <div className="flex items-center justify-between gap-x-2">
              <Text size="xsmall" leading="compact" weight="plus">
                {countryLabel(c.code, i18n.language)}
              </Text>
              {onRemove && (
                <Button size="small" variant="transparent" type="button" disabled={disabled} onClick={() => onRemove(c.code)}>
                  {t("shipping.removeCountry")}
                </Button>
              )}
            </div>
            {c.bands.map((b, i) => (
              <Text key={i} size="xsmall" leading="compact" className="text-ui-fg-subtle">
                {b.upTo === null
                  ? t("shipping.bandOpen", { from: b.from, price: formatPrice(b.price, currency) })
                  : t("shipping.band", { from: b.from, upTo: b.upTo, price: formatPrice(b.price, currency) })}
              </Text>
            ))}
          </div>
        ))}
      </div>
    </details>
  )
}
