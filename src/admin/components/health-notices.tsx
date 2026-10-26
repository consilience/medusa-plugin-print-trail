import { Alert, Text } from "@medusajs/ui"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import type { HealthView } from "../../lib/admin-types"

export const hasHealthNotices = (health: HealthView | null | undefined): health is HealthView =>
  !!health && (health.reconnect || !!health.channelInactive || health.unmatchedSkus > 0)

// "Reconnect Print Trail" after a 401, "The Print Trail channel is inactive"
// after API 1.2.0's channel-inactive 403, and the unmatched-SKU notice. Shown
// on the settings page, the order widget and the attention page (Medusa has
// no admin-wide notice area).
export const HealthNotices = ({ health }: { health: HealthView | null | undefined }) => {
  const { t } = useTranslation("printTrail")
  if (!hasHealthNotices(health)) return null
  return (
    <div className="flex flex-col gap-2">
      {health.channelInactive && (
        <Alert variant="error">
          <Text size="small" weight="plus" leading="compact">
            <Link to="/settings/print-trail" className="text-ui-fg-interactive hover:text-ui-fg-interactive-hover">
              {t("health.channelInactive")}
            </Link>
          </Text>
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {t("health.channelInactiveBody")}
          </Text>
        </Alert>
      )}
      {health.reconnect && (
        <Alert variant="error">
          <Text size="small" weight="plus" leading="compact">
            <Link to="/settings/print-trail" className="text-ui-fg-interactive hover:text-ui-fg-interactive-hover">
              {t("health.reconnect")}
            </Link>
          </Text>
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {t("health.reconnectBody")}
          </Text>
        </Alert>
      )}
      {health.unmatchedSkus > 0 && (
        <Alert variant="warning">
          <Text size="small" leading="compact">
            {t("health.unmatched", { count: health.unmatchedSkus })}{" "}
            <Link to="/settings/print-trail#sku-health" className="text-ui-fg-interactive hover:text-ui-fg-interactive-hover">
              {t("health.unmatchedLink")}
            </Link>
          </Text>
        </Alert>
      )}
    </div>
  )
}
