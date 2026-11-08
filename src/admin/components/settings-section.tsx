import { Badge, Button, Checkbox, Container, Drawer, Heading, Input, Label, Select, Switch, Text, Textarea, toast, usePrompt } from "@medusajs/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import type { ConfirmReasonDto, SaveSettingsResult, SettingKeyDto, SettingsView, SettingValueDto, SettingView } from "../../lib/admin-types"
import { api, errorOf, keys } from "../lib/api"
import { formatDate } from "../lib/format"
import { draftOf, examplePrefixNumber, methodChoices, type SettingDraft, SETTING_KINDS, valueOf } from "../lib/settings-form"

// Settings → Print Trail's editable settings: each value in force, where it
// comes from, who changed it, an edit drawer and a reset.

const LABEL_KEYS: Record<SettingKeyDto, string> = {
  orderNumberPrefix: "settings.options.orderNumberPrefix",
  defaultShippingMethod: "settings.options.defaultShippingMethod",
  confirmOn: "settings.options.confirmOn",
  strictSkus: "settings.options.strictSkus",
  "stockSync.enabled": "settings.options.stockSync",
  "reconcile.enabled": "settings.options.reconcile",
  "reconcile.lookbackDays": "settings.options.lookbackDays",
  autoComplete: "settings.options.autoComplete",
  "notifications.shipment": "settings.options.shipmentEmail",
  "notifications.cancelTooLate": "settings.options.cancelTooLateEmail",
  "notifications.adminEmail": "settings.options.adminEmails",
  stockLocationIds: "settings.options.stockLocations",
}

// The plugin's own template ids, offered when an email is turned on.
const DEFAULT_TEMPLATES: Partial<Record<SettingKeyDto, string>> = {
  "notifications.shipment": "print-trail-shipment",
  "notifications.cancelTooLate": "print-trail-cancel-too-late",
}

const useDisplay = (view: SettingsView | undefined) => {
  const { t } = useTranslation("printTrail")
  return (key: SettingKeyDto, value: SettingValueDto): string => {
    switch (SETTING_KINDS[key]) {
      case "switch":
        return value ? t("settings.options.on") : t("settings.options.off")
      case "template":
        return value === false ? t("settings.options.off") : String(value)
      case "emails":
        return Array.isArray(value) && value.length ? value.join(", ") : t("common.notSet")
      case "locations": {
        if (!Array.isArray(value) || !value.length) return t("settings.options.allLocations")
        const names = new Map((view?.choices.stockLocations ?? []).map((l) => [l.id, l.name ?? l.id]))
        return value.map((id) => names.get(id) ?? id).join(", ")
      }
      case "text":
        return value === "" ? t("common.none") : String(value)
      default:
        return String(value)
    }
  }
}

// Runs a save or reset; each time it needs a confirm, asks that question
// and runs it again with every confirm given so far. null: the admin
// declined.
const useConfirmedSave = () => {
  const { t } = useTranslation("printTrail")
  const prompt = usePrompt()
  return async (run: (confirm: ConfirmReasonDto[]) => Promise<SaveSettingsResult>): Promise<SaveSettingsResult | null> => {
    const confirmed: ConfirmReasonDto[] = []
    for (;;) {
      const result = await run([...confirmed])
      if (result.status !== "needs-confirmation" || confirmed.includes(result.reason)) return result
      const yes = await prompt(
        result.reason === "prefix-may-repeat"
          ? {
              title: t("settings.edit.confirmPrefixTitle"),
              description: result.numbers.length
                ? t("settings.edit.confirmPrefixBody", { numbers: result.numbers.join(", ") })
                : t("settings.edit.confirmPrefixPartial"),
              confirmText: t("settings.edit.confirmPrefixYes"),
              cancelText: t("common.cancel"),
              variant: "confirmation",
            }
          : {
              title: t("settings.edit.confirmPlacedTitle"),
              description: t("settings.edit.confirmPlacedBody", { count: result.count }),
              confirmText: t("settings.edit.confirmPlacedYes"),
              cancelText: t("common.cancel"),
              variant: "confirmation",
            }
      )
      if (!yes) return null
      confirmed.push(result.reason)
    }
  }
}

const toastWarnings = (result: SaveSettingsResult) => {
  if (result.status === "saved") for (const w of result.warnings) toast.warning(w)
}

const SettingRow = ({
  setting,
  view,
  onEdit,
  onReset,
  busy,
}: {
  setting: SettingView
  view: SettingsView
  onEdit: () => void
  onReset: () => void
  busy: boolean
}) => {
  const { t } = useTranslation("printTrail")
  const display = useDisplay(view)
  const who = setting.changed_by ? (setting.changed_by.name ?? setting.changed_by.email ?? setting.changed_by.id) : t("settings.edit.someone")
  return (
    <div className="grid grid-cols-2 items-start gap-4 px-6 py-3">
      <div className="flex flex-col gap-1">
        <Text size="small" leading="compact" weight="plus">
          {t(LABEL_KEYS[setting.key])}
        </Text>
        {setting.changed_at && (
          <Text size="xsmall" leading="compact" className="text-ui-fg-muted">
            {t(setting.source === "config" ? "settings.edit.resetBy" : "settings.edit.changedBy", { who, at: formatDate(setting.changed_at) })}
          </Text>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2 break-all">
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {display(setting.key, setting.value)}
          </Text>
          <Badge size="2xsmall" color={setting.source === "admin" ? "blue" : setting.source === "ignored" ? "orange" : "grey"}>
            {t(`settings.edit.source.${setting.source}`)}
          </Badge>
        </div>
        {setting.source === "admin" && (
          <Text size="xsmall" leading="compact" className="text-ui-fg-muted break-all">
            {t("settings.edit.configValue", { value: display(setting.key, setting.config) })}
          </Text>
        )}
        {setting.source === "ignored" && (
          <Text size="xsmall" leading="compact" className="text-ui-fg-muted">
            {t("settings.edit.ignoredHelp")}
          </Text>
        )}
        <div className="flex gap-2">
          <Button size="small" variant="transparent" onClick={onEdit} disabled={busy}>
            {t("common.edit")}
          </Button>
          {setting.source !== "config" && (
            <Button size="small" variant="transparent" onClick={onReset} disabled={busy}>
              {t("settings.edit.reset")}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

const DraftField = ({
  setting,
  view,
  draft,
  onChange,
  disabled,
}: {
  setting: SettingView
  view: SettingsView
  draft: SettingDraft
  onChange: (d: SettingDraft) => void
  disabled: boolean
}) => {
  const { t } = useTranslation("printTrail")
  const id = `pt-setting-${setting.key}`
  const hint = (text: string) => (
    <Text size="xsmall" leading="compact" className="text-ui-fg-subtle">
      {text}
    </Text>
  )
  switch (draft.kind) {
    case "switch":
      return (
        <div className="flex items-center gap-2">
          <Switch id={id} checked={draft.on} disabled={disabled} onCheckedChange={(on) => onChange({ ...draft, on })} />
          <Label htmlFor={id} size="small">
            {t(LABEL_KEYS[setting.key])}
          </Label>
        </div>
      )
    case "template":
      return (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Switch id={id} checked={draft.on} disabled={disabled} onCheckedChange={(on) => onChange({ ...draft, on })} />
            <Label htmlFor={id} size="small">
              {t("settings.edit.templateOn")}
            </Label>
          </div>
          {draft.on && (
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-id`} size="small" weight="plus">
                {t("settings.edit.templateId")}
              </Label>
              <Input id={`${id}-id`} size="small" value={draft.id} disabled={disabled} onChange={(e) => onChange({ ...draft, id: e.target.value })} />
            </div>
          )}
        </div>
      )
    case "locations":
      return (
        <div className="flex flex-col gap-2">
          {view.choices.stockLocations.length ? (
            view.choices.stockLocations.map((l) => (
              <div key={l.id} className="flex items-center gap-2">
                <Checkbox
                  id={`${id}-${l.id}`}
                  checked={draft.ids.includes(l.id)}
                  disabled={disabled}
                  onCheckedChange={(c) =>
                    onChange({ ...draft, ids: c === true ? [...draft.ids, l.id] : draft.ids.filter((x) => x !== l.id) })
                  }
                />
                <Label htmlFor={`${id}-${l.id}`} size="small">
                  {l.name ?? l.id}
                </Label>
              </div>
            ))
          ) : (
            hint(t("settings.edit.noLocations"))
          )}
          {hint(t("settings.edit.locationsHelp"))}
        </div>
      )
    case "emails":
      return (
        <div className="flex flex-col gap-1">
          <Textarea id={id} value={draft.text} disabled={disabled} onChange={(e) => onChange({ ...draft, text: e.target.value })} />
          {hint(t("settings.edit.emailsHelp", { max: view.limits.adminEmails }))}
        </div>
      )
    case "method":
    case "confirmOn": {
      const items =
        draft.kind === "method"
          ? (view.choices.shippingMethodsSource === "fallback"
              ? methodChoices(view.choices.shippingMethods, [setting.value, setting.config])
              : view.choices.shippingMethods
            ).map((m) => ({ value: m.code, label: m.name === m.code ? m.code : `${m.name} (${m.code})` }))
          : view.choices.confirmOn.map((v) => ({ value: v, label: v }))
      return (
        <div className="flex flex-col gap-1">
          <Select value={draft.text} onValueChange={(text) => onChange({ ...draft, text })} disabled={disabled} size="small">
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {items.map((i) => (
                <Select.Item key={i.value} value={i.value}>
                  {i.label}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
          {draft.kind === "confirmOn" && hint(t("settings.edit.confirmOnHelp"))}
        </div>
      )
    }
    case "number":
      return (
        <div className="flex flex-col gap-1">
          <Input
            id={id}
            size="small"
            type="number"
            min={view.limits.lookbackDays.min}
            max={view.limits.lookbackDays.max}
            value={draft.text}
            disabled={disabled}
            onChange={(e) => onChange({ ...draft, text: e.target.value })}
          />
          {hint(t("settings.edit.lookbackHelp", view.limits.lookbackDays))}
        </div>
      )
    default:
      return (
        <div className="flex flex-col gap-1">
          <Input id={id} size="small" value={draft.text} disabled={disabled} onChange={(e) => onChange({ ...draft, text: e.target.value })} />
          {hint(t("settings.edit.prefixHelp"))}
          {hint(t("settings.edit.prefixExample", { example: examplePrefixNumber(draft.text) }))}
        </div>
      )
  }
}

const EditDrawer = ({ setting, view, onClose }: { setting: SettingView; view: SettingsView; onClose: () => void }) => {
  const { t } = useTranslation("printTrail")
  const queryClient = useQueryClient()
  const confirmedSave = useConfirmedSave()
  const label = t(LABEL_KEYS[setting.key])
  const [draft, setDraft] = useState<SettingDraft>(() =>
    draftOf(setting.key, setting.value, typeof setting.config === "string" ? setting.config : (DEFAULT_TEMPLATES[setting.key] ?? ""))
  )
  const [error, setError] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: ({ value, confirm }: { value: SettingValueDto; confirm: ConfirmReasonDto[] }) => api.saveSettings({ [setting.key]: value }, confirm),
  })
  const submit = async () => {
    const parsed = valueOf(draft, view.limits)
    if (!parsed.ok) return setError(t(`settings.edit.errors.${parsed.error}`))
    setError(null)
    try {
      const result = await confirmedSave((confirm) => save.mutateAsync({ value: parsed.value, confirm }))
      if (!result || result.status !== "saved") return
      queryClient.setQueryData(keys.settings, result.view)
      queryClient.invalidateQueries({ queryKey: keys.connection })
      toast.success(t("settings.edit.saved", { label }))
      toastWarnings(result)
      onClose()
    } catch (e) {
      toast.error(t("common.error", { message: errorOf(e).message }))
    }
  }
  return (
    <Drawer open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <Drawer.Content>
        <Drawer.Header>
          <Drawer.Title>{t("settings.edit.title", { label })}</Drawer.Title>
        </Drawer.Header>
        <Drawer.Body className="flex flex-col gap-3 overflow-y-auto">
          <DraftField setting={setting} view={view} draft={draft} onChange={setDraft} disabled={save.isPending} />
          {error && (
            <Text size="small" leading="compact" className="text-ui-fg-error">
              {error}
            </Text>
          )}
        </Drawer.Body>
        <Drawer.Footer>
          <Drawer.Close asChild>
            <Button size="small" variant="secondary" disabled={save.isPending}>
              {t("common.cancel")}
            </Button>
          </Drawer.Close>
          <Button size="small" onClick={submit} isLoading={save.isPending} disabled={save.isPending}>
            {t("common.save")}
          </Button>
        </Drawer.Footer>
      </Drawer.Content>
    </Drawer>
  )
}

export const SettingsSection = () => {
  const { t } = useTranslation("printTrail")
  const queryClient = useQueryClient()
  const prompt = usePrompt()
  const confirmedSave = useConfirmedSave()
  const settings = useQuery({ queryKey: keys.settings, queryFn: () => api.settings() })
  const [editing, setEditing] = useState<SettingKeyDto | null>(null)
  const view = settings.data
  const display = useDisplay(view)
  const reset = useMutation({
    mutationFn: ({ key, confirm }: { key: SettingKeyDto; confirm: ConfirmReasonDto[] }) => api.resetSetting(key, confirm),
  })
  const resetSetting = async (s: SettingView) => {
    const label = t(LABEL_KEYS[s.key])
    const yes = await prompt({
      title: t("settings.edit.resetTitle", { label }),
      description: t("settings.edit.resetBody", { value: display(s.key, s.config) }),
      confirmText: t("settings.edit.resetYes"),
      cancelText: t("common.cancel"),
      variant: "confirmation",
    })
    if (!yes) return
    try {
      const result = await confirmedSave((confirm) => reset.mutateAsync({ key: s.key, confirm }))
      if (!result || result.status !== "saved") return
      queryClient.setQueryData(keys.settings, result.view)
      queryClient.invalidateQueries({ queryKey: keys.connection })
      toast.success(t("settings.edit.resetDone", { label }))
    } catch (e) {
      toast.error(t("common.error", { message: errorOf(e).message }))
    }
  }
  const current = view?.settings.find((s) => s.key === editing)
  return (
    <Container className="divide-y p-0">
      <div className="flex flex-col gap-1 px-6 py-4">
        <Heading level="h2">{t("settings.options.heading")}</Heading>
        <Text size="small" leading="compact" className="text-ui-fg-subtle">
          {t("settings.options.help")}
        </Text>
      </div>
      {!view ? (
        <div className="px-6 py-4">
          <Text size="small" className="text-ui-fg-subtle">
            {settings.isError ? t("common.error", { message: errorOf(settings.error).message }) : t("common.loading")}
          </Text>
        </div>
      ) : (
        view.settings.map((s) => (
          <SettingRow key={s.key} setting={s} view={view} onEdit={() => setEditing(s.key)} onReset={() => resetSetting(s)} busy={reset.isPending} />
        ))
      )}
      {view && current && <EditDrawer key={current.key} setting={current} view={view} onClose={() => setEditing(null)} />}
    </Container>
  )
}
