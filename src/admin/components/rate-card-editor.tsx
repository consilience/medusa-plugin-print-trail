import { Button, Hint, Input, Label, Select, Text } from "@medusajs/ui"
import { useTranslation } from "react-i18next"
import type { ShippingOptionChoices } from "../../lib/admin-types"
import { removeCountry, type RateCardForm } from "../lib/rate-card-form"
import { CountryBands } from "./country-bands"

type Props = {
  form: RateCardForm
  onChange: (form: RateCardForm) => void
  // Field path → i18n key.
  errors: Record<string, string>
  choices: ShippingOptionChoices
  // On edit, the zone and profile are fixed.
  scopeLocked?: boolean
  disabled?: boolean
}

const FieldError = ({ error }: { error?: string }) => {
  const { t } = useTranslation("printTrail")
  return error ? <Hint variant="error">{t(error)}</Hint> : null
}

// The form body shared by create (FocusModal) and edit (Drawer).
export const RateCardEditor = ({ form, onChange, errors, choices, scopeLocked, disabled }: Props) => {
  const { t } = useTranslation("printTrail")
  const set = (patch: Partial<RateCardForm>) => onChange({ ...form, ...patch })
  const setBand = (i: number, patch: Partial<RateCardForm["bands"][number]>) =>
    set({ bands: form.bands.map((b, j) => (j === i ? { ...b, ...patch } : b)) })
  const zoneLabel = (z: { name: string; location: string | null }) => (z.location ? `${z.name} (${z.location})` : z.name)

  return (
    <div className="flex flex-col gap-y-4">
      <div className="flex flex-col gap-y-2">
        <Label size="small" weight="plus" htmlFor="pt-name">
          {t("shipping.name")}
        </Label>
        <Input id="pt-name" size="small" value={form.name} disabled={disabled} onChange={(e) => set({ name: e.target.value })} />
        <FieldError error={errors.name} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-y-2">
          <Label size="small" weight="plus">
            {t("shipping.serviceZone")}
          </Label>
          <Select value={form.service_zone_id} onValueChange={(v) => set({ service_zone_id: v })} disabled={disabled || scopeLocked} size="small">
            <Select.Trigger>
              <Select.Value placeholder={t("shipping.select")} />
            </Select.Trigger>
            <Select.Content>
              {choices.service_zones.map((z) => (
                <Select.Item key={z.id} value={z.id}>
                  {zoneLabel(z)}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
          {scopeLocked ? <Hint>{t("shipping.readOnly")}</Hint> : <FieldError error={errors.service_zone_id} />}
        </div>
        <div className="flex flex-col gap-y-2">
          <Label size="small" weight="plus">
            {t("shipping.profile")}
          </Label>
          <Select value={form.shipping_profile_id} onValueChange={(v) => set({ shipping_profile_id: v })} disabled={disabled || scopeLocked} size="small">
            <Select.Trigger>
              <Select.Value placeholder={t("shipping.select")} />
            </Select.Trigger>
            <Select.Content>
              {choices.shipping_profiles.map((p) => (
                <Select.Item key={p.id} value={p.id}>
                  {p.name}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
          {scopeLocked ? <Hint>{t("shipping.readOnly")}</Hint> : <FieldError error={errors.shipping_profile_id} />}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-y-2">
          <Label size="small" weight="plus">
            {t("shipping.method")}
          </Label>
          <Select value={form.method} onValueChange={(v) => set({ method: v })} disabled={disabled} size="small">
            <Select.Trigger>
              <Select.Value placeholder={t("shipping.select")} />
            </Select.Trigger>
            <Select.Content>
              {choices.methods.codes.map((code) => (
                <Select.Item key={code} value={code}>
                  {code}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
          {choices.methods.source === "fallback" && <Hint>{t("shipping.methodsFallback")}</Hint>}
          <FieldError error={errors.method} />
        </div>
        <div className="flex flex-col gap-y-2">
          <Label size="small" weight="plus" htmlFor="pt-currency">
            {t("shipping.currency")}
          </Label>
          <Input
            id="pt-currency"
            size="small"
            value={form.currency_code}
            placeholder={t("shipping.currencyHint")}
            disabled={disabled}
            onChange={(e) => set({ currency_code: e.target.value.toUpperCase() })}
          />
          <FieldError error={errors.currency_code} />
        </div>
      </div>

      <div className="flex flex-col gap-y-2">
        <Label size="small" weight="plus">
          {t("shipping.bands")}
        </Label>
        <Text size="small" leading="compact" className="text-ui-fg-subtle">
          {t("shipping.bandsHint")}
        </Text>
        <FieldError error={errors.bands} />
        {form.bands.map((band, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-start gap-2">
            <div className="flex flex-col gap-y-1">
              <Input
                size="small"
                inputMode="decimal"
                aria-label={t("shipping.maxWeight")}
                placeholder={i === form.bands.length - 1 ? t("shipping.noLimit") : t("shipping.maxWeight")}
                value={band.max_weight}
                disabled={disabled}
                onChange={(e) => setBand(i, { max_weight: e.target.value })}
              />
              <FieldError error={errors[`bands.${i}.max_weight`]} />
            </div>
            <div className="flex flex-col gap-y-1">
              <Input
                size="small"
                inputMode="decimal"
                aria-label={t("shipping.price")}
                placeholder={t("shipping.price")}
                value={band.price}
                disabled={disabled}
                onChange={(e) => setBand(i, { price: e.target.value })}
              />
              <FieldError error={errors[`bands.${i}.price`] ?? errors[`bands.${i}.prices`]} />
            </div>
            <Button
              size="small"
              variant="transparent"
              type="button"
              disabled={disabled || form.bands.length === 1}
              onClick={() => set({ bands: form.bands.filter((_, j) => j !== i) })}
            >
              {t("shipping.removeBand")}
            </Button>
          </div>
        ))}
        <div>
          <Button
            size="small"
            variant="secondary"
            type="button"
            disabled={disabled}
            onClick={() => set({ bands: [...form.bands, { max_weight: "", price: "" }] })}
          >
            {t("shipping.addBand")}
          </Button>
        </div>
      </div>

      {form.countries && Object.keys(form.countries).length > 0 && (
        <div className="flex flex-col gap-y-2">
          <Label size="small" weight="plus">
            {t("shipping.countries")}
          </Label>
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {t("shipping.countriesHint")}
          </Text>
          <FieldError error={errors.countries} />
          <CountryBands
            card={{ method: form.method, currency_code: form.currency_code.toLowerCase(), bands: [], countries: form.countries }}
            onRemove={(code) => onChange(removeCountry(form, code))}
            disabled={disabled}
            open={!!errors.countries}
          />
        </div>
      )}
    </div>
  )
}
