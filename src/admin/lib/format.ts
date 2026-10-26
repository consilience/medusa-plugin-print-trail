// Display helpers shared by the pages and widgets.

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

// A calendar date (YYYY-MM-DD, as Print Trail's publicationDate): shown in
// the viewer's locale without a time or a timezone shift.
export function formatDay(day: string | null | undefined): string {
  if (!day) return ""
  const d = new Date(`${day.slice(0, 10)}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString(undefined, { timeZone: "UTC", dateStyle: "medium" })
}

// Prices are major units as stored (3.95 is £3.95): formatted, never scaled.
export function formatPrice(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(amount)
  } catch {
    return `${amount} ${currency.toUpperCase()}`
  }
}

// The setup the empty state shows: code, not copy.
export const ENV_SNIPPET = [
  "PRINT_TRAIL_BASE_URL=https://printtrail-core.consilstaging.com",
  "PRINT_TRAIL_CHANNEL_ID=",
  "PRINT_TRAIL_API_TOKEN=",
  "MEDUSA_BACKEND_URL=https://",
  "MEDUSA_ADMIN_URL=https://",
].join("\n")

export const CONFIG_SNIPPET = `import { printTrailOptionsFromEnv } from "medusa-plugin-print-trail/config"

const printTrail = printTrailOptionsFromEnv()

module.exports = defineConfig({
  plugins: [{
    resolve: "medusa-plugin-print-trail",
    options: {
      ...printTrail,
      backendUrl: process.env.MEDUSA_BACKEND_URL,
      adminUrl: process.env.MEDUSA_ADMIN_URL,
      notifications: { adminEmail: process.env.PRINT_TRAIL_ADMIN_EMAIL },
    },
  }],
  modules: [{
    resolve: "@medusajs/medusa/fulfillment",
    options: {
      providers: [
        { resolve: "@medusajs/medusa/fulfillment-manual", id: "manual" },
        {
          resolve: "medusa-plugin-print-trail/providers/print-trail",
          id: "print-trail",
          options: printTrail,
        },
      ],
    },
  }],
})`
