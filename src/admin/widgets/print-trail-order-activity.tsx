import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { DetailWidgetProps, HttpTypes } from "@medusajs/framework/types"
import { Badge, Container, Heading, Table, Text } from "@medusajs/ui"
import { useTranslation } from "react-i18next"
import { PrintTrailLink } from "../components/print-trail-link"
import { formatDate, formatDay } from "../lib/format"
import { statusColor } from "../lib/labels"
import { useOrderView } from "../lib/order-query"

// Print Trail's fulfilments (per Print Trail order) and the plugin's
// timeline, in the main column.
const OrderActivityWidget = ({ data: order }: DetailWidgetProps<HttpTypes.AdminOrder>) => {
  const { t } = useTranslation("printTrail")
  const { data: view, isLoading } = useOrderView(order.id)

  if (isLoading) {
    return (
      <Container className="px-6 py-4">
        <Text size="small" className="text-ui-fg-subtle">
          {t("common.loading")}
        </Text>
      </Container>
    )
  }
  if (!view || (view.rows.length === 0 && !view.expected)) return null

  const withFulfilments = view.rows.filter((r) => r.fulfilments.length > 0)
  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading level="h2">{t("order.activity")}</Heading>
      </div>
      <div className="flex flex-col gap-y-4 px-6 py-4">
        <Text size="small" leading="compact" weight="plus">
          {t("order.fulfilments")}
        </Text>
        {withFulfilments.length === 0 && (
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {t("order.noFulfilments")}
          </Text>
        )}
        {withFulfilments.map((row) => (
          <div key={row.id} className="flex flex-col gap-y-2">
            <PrintTrailLink number={row.pt_order_number} url={row.pt_url} />
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>{t("order.number")}</Table.HeaderCell>
                  <Table.HeaderCell>{t("order.location")}</Table.HeaderCell>
                  <Table.HeaderCell>{t("order.production")}</Table.HeaderCell>
                  <Table.HeaderCell>{t("order.status")}</Table.HeaderCell>
                  <Table.HeaderCell>{t("order.shippingMethod")}</Table.HeaderCell>
                  <Table.HeaderCell>{t("order.tracking")}</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {row.fulfilments.map((f) => (
                  <Table.Row key={f.uuid}>
                    <Table.Cell>
                      {row.pt_url ? (
                        <a href={row.pt_url} target="_blank" rel="noreferrer" className="text-ui-fg-interactive hover:text-ui-fg-interactive-hover">
                          {f.number ?? f.uuid}
                        </a>
                      ) : (
                        f.number ?? f.uuid
                      )}
                    </Table.Cell>
                    <Table.Cell>{f.location ?? ""}</Table.Cell>
                    <Table.Cell>{f.productionMethod ?? ""}</Table.Cell>
                    <Table.Cell>
                      {f.back_order === "pre-order" && f.product_inactive ? (
                        <Badge size="2xsmall" color="orange">
                          {t("order.fulfilment.waitingInactive")}
                        </Badge>
                      ) : f.back_order === "pre-order" ? (
                        <Badge size="2xsmall" color="blue">
                          {f.publication_date
                            ? t("order.fulfilment.waitingOn", { date: formatDay(f.publication_date) })
                            : t("order.fulfilment.waiting")}
                        </Badge>
                      ) : f.back_order ? (
                        <Badge size="2xsmall" color="orange">
                          {t(f.back_order === "warehouse" ? "order.fulfilment.warehouse" : "order.fulfilment.outOfStock")}
                        </Badge>
                      ) : (
                        <Badge size="2xsmall" color={statusColor(f.status)}>
                          {f.status}
                        </Badge>
                      )}
                    </Table.Cell>
                    <Table.Cell>{f.shippingMethod ?? ""}</Table.Cell>
                    <Table.Cell>
                      <div className="flex flex-col">
                        {f.tracking.map((tr, i) =>
                          tr.url ? (
                            <a key={i} href={tr.url} target="_blank" rel="noreferrer" className="text-ui-fg-interactive hover:text-ui-fg-interactive-hover">
                              {tr.number || tr.url}
                            </a>
                          ) : (
                            <span key={i}>{tr.number}</span>
                          )
                        )}
                      </div>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-y-3 px-6 py-4">
        <Text size="small" leading="compact" weight="plus">
          {t("order.timeline")}
        </Text>
        {view.timeline.length === 0 && (
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {t("order.noTimeline")}
          </Text>
        )}
        {view.timeline.map((e) => (
          <div key={e.id} className="flex flex-col gap-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Text size="xsmall" leading="compact" className="text-ui-fg-muted">
                {formatDate(e.at)}
              </Text>
              <Badge size="2xsmall" color="grey">
                {e.kind}
              </Badge>
              {e.pt_order_number && <PrintTrailLink number={e.pt_order_number} url={e.pt_url} weight="regular" />}
            </div>
            <Text size="small" leading="compact">
              {e.message}
            </Text>
          </div>
        ))}
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details",
  id: "print-trail:order-activity",
})

export default OrderActivityWidget
