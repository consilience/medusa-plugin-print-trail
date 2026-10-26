import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Alert, Text } from "@medusajs/ui"
import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { api, keys } from "../lib/api"

// The order list's count of Print Trail orders needing attention (Medusa's
// list can't filter on plugin data), with a link to the full list.
const AttentionCountWidget = () => {
  const { t } = useTranslation("printTrail")
  const { data } = useQuery({ queryKey: keys.attention(1, 0), queryFn: () => api.attention(1, 0) })
  if (!data || data.count === 0) return null
  return (
    <Alert variant="warning">
      <div className="flex items-center justify-between gap-2">
        <Text size="small" leading="compact">
          {t("attention.count", { count: data.count })}
        </Text>
        <Link to="/print-trail/attention" className="text-ui-fg-interactive hover:text-ui-fg-interactive-hover txt-compact-small-plus">
          {t("attention.view")}
        </Link>
      </div>
    </Alert>
  )
}

export const config = defineWidgetConfig({
  zone: "order.list",
  id: "print-trail:attention-count",
})

export default AttentionCountWidget
