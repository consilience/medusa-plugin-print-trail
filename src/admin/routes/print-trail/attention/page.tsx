import { defineRouteConfig } from "@medusajs/admin-sdk"
import { Button, Container, Heading, Table, Text, Tooltip, toast, usePrompt } from "@medusajs/ui"
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import type { AttentionRow } from "../../../../lib/admin-types"
import { hasHealthNotices, HealthNotices } from "../../../components/health-notices"
import { PrintTrailLink } from "../../../components/print-trail-link"
import { api, errorOf, keys } from "../../../lib/api"
import { formatDate } from "../../../lib/format"
import { attentionKey, dismissBodyKey, refusalKey } from "../../../lib/labels"

const PAGE_SIZE = 20
const ERROR_PREVIEW = 80

const AttentionPage = () => {
  const { t } = useTranslation("printTrail")
  const queryClient = useQueryClient()
  const prompt = usePrompt()
  const [page, setPage] = useState(0)
  const { data, isLoading, isError, error } = useQuery({
    queryKey: keys.attention(PAGE_SIZE, page * PAGE_SIZE),
    queryFn: () => api.attention(PAGE_SIZE, page * PAGE_SIZE),
    placeholderData: keepPreviousData,
  })
  const dismiss = useMutation({
    mutationFn: (row: AttentionRow) => api.dismiss(row.order_id, { print_trail_order_id: row.id, attention: row.attention }),
    onSuccess: (r, row) => {
      if (r.status === "dismissed") toast.success(t("order.dismissed"))
      else toast.info(t("order.dismissUnchanged"))
      queryClient.invalidateQueries({ queryKey: keys.order(row.order_id) })
    },
    onError: (e) => {
      const { status, message } = errorOf(e)
      toast.error(status === 409 || status === 400 ? t(refusalKey(message), { defaultValue: message }) : t("common.error", { message }))
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.attentionAll }),
  })
  const confirmDismiss = async (row: AttentionRow) => {
    const l = attentionKey(row.attention)
    const yes = await prompt({
      title: t("order.dismissTitle"),
      description: t(dismissBodyKey(row.attention), { label: t(l.key, l.values) }),
      confirmText: t("order.dismiss"),
      cancelText: t("common.cancel"),
      variant: "confirmation",
    })
    if (yes) dismiss.mutate(row)
  }

  const count = data?.count ?? 0
  const pageCount = Math.max(1, Math.ceil(count / PAGE_SIZE))
  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading level="h1">{t("attention.title")}</Heading>
        <Text size="small" leading="compact" className="text-ui-fg-subtle mt-1">
          {t("attention.description")}
        </Text>
      </div>
      {data && hasHealthNotices(data.health) && (
        <div className="px-6 py-4">
          <HealthNotices health={data.health} />
        </div>
      )}
      {isLoading || !data ? (
        <div className="px-6 py-4">
          <Text size="small" className="text-ui-fg-subtle">
            {isError ? t("common.error", { message: errorOf(error).message }) : t("common.loading")}
          </Text>
        </div>
      ) : data.rows.length === 0 ? (
        <div className="px-6 py-4">
          <Text size="small" className="text-ui-fg-subtle">
            {t("attention.empty")}
          </Text>
        </div>
      ) : (
        <>
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>{t("attention.order")}</Table.HeaderCell>
                <Table.HeaderCell>{t("attention.printTrailOrder")}</Table.HeaderCell>
                <Table.HeaderCell>{t("attention.issue")}</Table.HeaderCell>
                <Table.HeaderCell>{t("attention.lastError")}</Table.HeaderCell>
                <Table.HeaderCell>{t("attention.updated")}</Table.HeaderCell>
                <Table.HeaderCell />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.rows.map((row) => {
                const l = attentionKey(row.attention)
                return (
                  <Table.Row key={row.id}>
                    <Table.Cell>
                      <Link to={`/orders/${row.order_id}`} className="text-ui-fg-interactive hover:text-ui-fg-interactive-hover">
                        {row.display_id !== null ? `#${row.display_id}` : row.order_id}
                      </Link>
                    </Table.Cell>
                    <Table.Cell>
                      <PrintTrailLink number={row.pt_order_number} url={row.pt_url} weight="regular" />
                    </Table.Cell>
                    <Table.Cell>{t(l.key, l.values)}</Table.Cell>
                    <Table.Cell>
                      {row.last_error ? (
                        <Tooltip content={row.last_error}>
                          <span className="block max-w-[240px] truncate">
                            {row.last_error.length > ERROR_PREVIEW ? `${row.last_error.slice(0, ERROR_PREVIEW)}…` : row.last_error}
                          </span>
                        </Tooltip>
                      ) : null}
                    </Table.Cell>
                    <Table.Cell>{formatDate(row.updated_at)}</Table.Cell>
                    <Table.Cell>
                      {row.dismissable && (
                        <Button size="small" variant="transparent" disabled={dismiss.isPending} onClick={() => confirmDismiss(row)}>
                          {t("order.dismiss")}
                        </Button>
                      )}
                    </Table.Cell>
                  </Table.Row>
                )
              })}
            </Table.Body>
          </Table>
          <Table.Pagination
            count={count}
            pageSize={PAGE_SIZE}
            pageIndex={page}
            pageCount={pageCount}
            canPreviousPage={page > 0}
            canNextPage={page + 1 < pageCount}
            previousPage={() => setPage((p) => Math.max(0, p - 1))}
            nextPage={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            translations={{
              of: t("common.of"),
              results: t("common.results"),
              pages: t("common.pages"),
              prev: t("common.previous"),
              next: t("common.next"),
            }}
          />
        </>
      )}
    </Container>
  )
}

export const config = defineRouteConfig({
  label: "attention.title",
  translationNs: "printTrail",
  nested: "/orders",
})

export default AttentionPage
