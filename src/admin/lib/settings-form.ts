import type { SettingKeyDto, SettingsView, SettingValueDto } from "../../lib/admin-types"

// The settings page's edit drawer: one setting at a time, as a draft the
// form edits, turned back into the value the route takes. The route checks
// everything again; these checks only spare a round trip.

export type SettingKind = "text" | "method" | "confirmOn" | "switch" | "number" | "template" | "emails" | "locations"

export const SETTING_KINDS: Record<SettingKeyDto, SettingKind> = {
  orderNumberPrefix: "text",
  defaultShippingMethod: "method",
  confirmOn: "confirmOn",
  strictSkus: "switch",
  "stockSync.enabled": "switch",
  "reconcile.enabled": "switch",
  "reconcile.lookbackDays": "number",
  autoComplete: "switch",
  "notifications.shipment": "template",
  "notifications.cancelTooLate": "template",
  "notifications.adminEmail": "emails",
  stockLocationIds: "locations",
}

export type SettingDraft =
  | { kind: "text" | "method" | "confirmOn" | "number" | "emails"; text: string }
  | { kind: "switch"; on: boolean }
  | { kind: "template"; on: boolean; id: string }
  | { kind: "locations"; ids: string[] }

export function draftOf(key: SettingKeyDto, value: SettingValueDto, fallbackTemplate = ""): SettingDraft {
  const kind = SETTING_KINDS[key]
  switch (kind) {
    case "switch":
      return { kind, on: value === true }
    case "template":
      return value === false ? { kind, on: false, id: fallbackTemplate } : { kind, on: true, id: String(value) }
    case "locations":
      return { kind, ids: Array.isArray(value) ? [...value] : [] }
    case "emails":
      return { kind, text: Array.isArray(value) ? value.join(", ") : "" }
    default:
      return { kind, text: String(value) }
  }
}

// Addresses separated by commas, semicolons, spaces or new lines.
export const emailsIn = (text: string) => [...new Set(text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))]

// Close to the route's own check (which is the one that counts).
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PREFIX = /^[A-Za-z0-9._\-/#]*$/

export type DraftResult = { ok: true; value: SettingValueDto } | { ok: false; error: string }

// The error is an i18n key under settings.edit.errors.
export function valueOf(draft: SettingDraft, limits: SettingsView["limits"]): DraftResult {
  switch (draft.kind) {
    case "switch":
      return { ok: true, value: draft.on }
    case "template":
      if (!draft.on) return { ok: true, value: false }
      return draft.id.trim() ? { ok: true, value: draft.id.trim() } : { ok: false, error: "template" }
    case "locations":
      return { ok: true, value: draft.ids }
    case "emails": {
      const list = emailsIn(draft.text)
      if (list.some((e) => !EMAIL.test(e))) return { ok: false, error: "email" }
      if (list.length > limits.adminEmails) return { ok: false, error: "emailCount" }
      return { ok: true, value: list }
    }
    case "number": {
      const n = Number(draft.text.trim())
      const { min, max } = limits.lookbackDays
      if (!draft.text.trim() || !Number.isInteger(n) || n < min || n > max) return { ok: false, error: "lookbackDays" }
      return { ok: true, value: n }
    }
    case "text":
      if (!PREFIX.test(draft.text)) return { ok: false, error: "prefixCharacters" }
      if ([...draft.text].length > limits.prefixMaxLength) return { ok: false, error: "prefixLength" }
      return { ok: true, value: draft.text }
    default:
      return draft.text ? { ok: true, value: draft.text } : { ok: false, error: "required" }
  }
}

// How the next order would be numbered with this prefix, for the drawer.
export const examplePrefixNumber = (prefix: string) => `${prefix}1001`

// The shipping methods the drawer offers: those listed (Print Trail's, or
// the fallback codes), with the method in force and the plugin options'
// added when the list lacks them, so the drawer can always show and keep
// the current method.
export function methodChoices(listed: { code: string; name: string }[], current: unknown[]): { code: string; name: string }[] {
  const out = [...listed]
  for (const code of current) {
    if (typeof code === "string" && code && !out.some((m) => m.code === code)) out.push({ code, name: code })
  }
  return out
}
