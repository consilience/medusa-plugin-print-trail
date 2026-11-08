import fs from "node:fs"
import path from "node:path"
import { draftOf, emailsIn, methodChoices, SETTING_KINDS, valueOf } from "../settings-form"

describe("methodChoices", () => {
  it("keeps the method in force and the plugin options' in the list when the fallback list lacks them", () => {
    const listed = [{ code: "standard", name: "standard" }]
    expect(methodChoices(listed, ["courier-48", "standard"]).map((m) => m.code)).toEqual(["standard", "courier-48"])
    expect(methodChoices(listed, ["standard", "standard"])).toEqual(listed)
  })
})

const en = JSON.parse(fs.readFileSync(path.join(__dirname, "../../i18n/json/en.json"), "utf8"))
const has = (key: string) => key.split(".").reduce<unknown>((node, k) => (node as Record<string, unknown> | undefined)?.[k], en) !== undefined

const limits = { prefixMaxLength: 239, lookbackDays: { min: 1, max: 90 }, adminEmails: 20 }

describe("settings form", () => {
  it("round-trips each kind of setting", () => {
    expect(valueOf(draftOf("orderNumberPrefix", "WEB-"), limits)).toEqual({ ok: true, value: "WEB-" })
    expect(valueOf(draftOf("orderNumberPrefix", ""), limits)).toEqual({ ok: true, value: "" })
    expect(valueOf(draftOf("strictSkus", false), limits)).toEqual({ ok: true, value: false })
    expect(valueOf(draftOf("reconcile.lookbackDays", 14), limits)).toEqual({ ok: true, value: 14 })
    expect(valueOf(draftOf("notifications.shipment", false, "print-trail-shipment"), limits)).toEqual({ ok: true, value: false })
    expect(valueOf(draftOf("notifications.adminEmail", ["a@example.com", "b@example.com"]), limits)).toEqual({
      ok: true,
      value: ["a@example.com", "b@example.com"],
    })
    expect(valueOf(draftOf("stockLocationIds", []), limits)).toEqual({ ok: true, value: [] })
  })

  it("turning an email on offers the template id", () => {
    const draft = draftOf("notifications.cancelTooLate", false, "print-trail-cancel-too-late")
    expect(draft).toEqual({ kind: "template", on: false, id: "print-trail-cancel-too-late" })
    expect(valueOf({ ...draft, on: true } as never, limits)).toEqual({ ok: true, value: "print-trail-cancel-too-late" })
    expect(valueOf({ kind: "template", on: true, id: " " }, limits)).toEqual({ ok: false, error: "template" })
  })

  it("splits addresses on commas, semicolons, spaces and new lines, once each", () => {
    expect(emailsIn("a@example.com, b@example.com;\nc@example.com a@example.com")).toEqual(["a@example.com", "b@example.com", "c@example.com"])
    expect(valueOf({ kind: "emails", text: "ops@" }, limits)).toEqual({ ok: false, error: "email" })
  })

  it("refuses a bad prefix and a look-back out of range", () => {
    expect(valueOf({ kind: "text", text: "WEB 1" }, limits)).toEqual({ ok: false, error: "prefixCharacters" })
    expect(valueOf({ kind: "text", text: "A".repeat(240) }, limits)).toEqual({ ok: false, error: "prefixLength" })
    expect(valueOf({ kind: "number", text: "0" }, limits)).toEqual({ ok: false, error: "lookbackDays" })
    expect(valueOf({ kind: "number", text: "2.5" }, limits)).toEqual({ ok: false, error: "lookbackDays" })
    expect(valueOf({ kind: "number", text: "" }, limits)).toEqual({ ok: false, error: "lookbackDays" })
  })

  it("every error and label it shows is in the strings", () => {
    for (const e of ["template", "email", "emailCount", "lookbackDays", "prefixCharacters", "prefixLength", "required"]) {
      expect(has(`settings.edit.errors.${e}`)).toBe(true)
    }
    expect(Object.keys(SETTING_KINDS)).toHaveLength(12)
    for (const k of ["orderNumberPrefix", "lookbackDays", "stockLocations", "adminEmails", "shipmentEmail", "cancelTooLateEmail"]) {
      expect(has(`settings.options.${k}`)).toBe(true)
    }
    expect(has("settings.edit.source.admin") && has("settings.edit.source.config") && has("settings.deployment.heading")).toBe(true)
  })
})
