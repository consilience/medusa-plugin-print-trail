import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { ArrowPath, EllipsisHorizontal, CheckCircle } from "@medusajs/icons"
import type { DetailWidgetProps, HttpTypes } from "@medusajs/framework/types"
import { Alert, Badge, Button, Container, DropdownMenu, Heading, IconButton, Text, toast, usePrompt } from "@medusajs/ui"
import { useMutation } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import type { DismissResult, OrderRowView, OrderView, RefreshResult, ResendResult } from "../../lib/admin-types"
import { hasHealthNotices, HealthNotices } from "../components/health-notices"
import { PrintTrailLink } from "../components/print-trail-link"
import { api, errorOf } from "../lib/api"
import { formatDate } from "../lib/format"
import { attentionKey, dismissBodyKey, blockReasonKey, onlyWaitingForRelease, refusalKey, sendOutcomeKey, statusColor } from "../lib/labels"
import { useInvalidateOrder, useOrderView } from "../lib/order-query"

type Mutations = {
  refresh: () => void
  resend: (row: OrderRowView) => void
  resendAsNew: (row: OrderRowView) => void
  dismiss: (row: OrderRowView) => void
  pending: boolean
}

const sourceKey = (ref: string | null) => {
  const kind = ref?.split(":")[0]
  return kind === "claim" || kind === "exchange" || kind === "reissue" || kind === "remainder" ? `order.${kind}` : null
}

const RowBlock = ({ row, view, m }: { row: OrderRowView; view: OrderView; m: Mutations }) => {
  const { t } = useTranslation("printTrail")
  const label = (l: { key: string; values?: Record<string, string> }) => t(l.key, l.values)
  const source = sourceKey(row.source_ref)
  const anyAction = row.actions.refresh || row.actions.resend || row.actions.resend_as_new || row.actions.dismiss
  return (
    <div className="flex flex-col gap-y-3 px-6 py-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <PrintTrailLink number={row.pt_order_number} url={row.pt_url} />
          {source && (
            <Badge size="2xsmall" color="grey">
              {t(source)}
            </Badge>
          )}
        </div>
        {anyAction && (
          <DropdownMenu>
            <DropdownMenu.Trigger asChild>
              <IconButton size="small" variant="transparent" disabled={m.pending}>
                <EllipsisHorizontal />
              </IconButton>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content>
              {row.actions.refresh && (
                <DropdownMenu.Item className="gap-x-2" disabled={m.pending} onClick={m.refresh}>
                  <ArrowPath className="text-ui-fg-subtle" />
                  {t("order.refresh")}
                </DropdownMenu.Item>
              )}
              {row.actions.resend && (
                <DropdownMenu.Item className="gap-x-2" disabled={m.pending} onClick={() => m.resend(row)}>
                  <ArrowPath className="text-ui-fg-subtle" />
                  {t("order.resend")}
                </DropdownMenu.Item>
              )}
              {row.actions.resend_as_new && (
                <DropdownMenu.Item className="gap-x-2" disabled={m.pending} onClick={() => m.resendAsNew(row)}>
                  <ArrowPath className="text-ui-fg-subtle" />
                  {t("order.resendAsNew")}
                </DropdownMenu.Item>
              )}
              {row.actions.dismiss && (
                <DropdownMenu.Item className="gap-x-2" disabled={m.pending} onClick={() => m.dismiss(row)}>
                  <CheckCircle className="text-ui-fg-subtle" />
                  {t("order.dismiss")}
                </DropdownMenu.Item>
              )}
            </DropdownMenu.Content>
          </DropdownMenu>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {row.status && onlyWaitingForRelease(row) ? (
          <Badge size="2xsmall" color="blue">
            {t("order.waitingRelease")}
          </Badge>
        ) : (
          row.status && (
            <Badge size="2xsmall" color={statusColor(row.status)}>
              {row.status}
            </Badge>
          )
        )}
        {row.fulfillable_status && (
          <Badge size="2xsmall" color={statusColor(row.fulfillable_status)}>
            {row.fulfillable_status}
          </Badge>
        )}
      </div>

      <Text size="small" leading="compact" className="text-ui-fg-subtle">
        {row.confirmed_at ? t("order.confirmed", { at: formatDate(row.confirmed_at) }) : t("order.notConfirmed")}
      </Text>

      {row.block_reason && !row.confirmed_at && (
        <Alert variant="error">
          <Text size="small" leading="compact" weight="plus">
            {t("order.blocked", { reason: label(blockReasonKey(row.block_reason)) })}
          </Text>
          {row.last_error && (
            <Text size="small" leading="compact" className="text-ui-fg-subtle break-all">
              {row.last_error}
            </Text>
          )}
        </Alert>
      )}

      {row.attention && (
        <div className="flex flex-col gap-1">
          <Badge size="2xsmall" color="orange" className="w-fit">
            {t("order.attention")}
          </Badge>
          <Text size="small" leading="compact">
            {label(attentionKey(row.attention))}
          </Text>
        </div>
      )}

      {row.pending_action && (
        <Text size="small" leading="compact" className="text-ui-fg-subtle">
          {row.next_attempt_at
            ? t("order.pendingRetry", { action: row.pending_action, at: formatDate(row.next_attempt_at) })
            : t("order.pendingNow", { action: row.pending_action })}
        </Text>
      )}

      {row.cancel_status && (
        <Text size="small" leading="compact" className="text-ui-fg-subtle">
          {t("order.cancelStatus.label")}: {t(`order.cancelStatus.${row.cancel_status}`, { defaultValue: row.cancel_status })}
        </Text>
      )}

      {row.held_lines > 0 && (
        <Text size="small" leading="compact" className="text-ui-fg-subtle">
          {t("order.held", { count: row.held_lines })}
        </Text>
      )}

      {row.cancel_warning && !view.canceled && (
        <Alert variant="warning">
          <Text size="small" leading="compact">
            {t("order.cancelWarning")}
          </Text>
          <ul className="mt-1 list-disc pl-4">
            {row.cancel_warning.map((f) => (
              <li key={f.uuid}>
                <Text size="small" leading="compact" className="text-ui-fg-subtle">
                  {[f.number ?? f.uuid, f.location, f.status, ...f.tracking.map((tr) => tr.number)].filter(Boolean).join(" · ")}
                </Text>
              </li>
            ))}
          </ul>
        </Alert>
      )}
    </div>
  )
}

const OrderSummaryWidget = ({ data: order }: DetailWidgetProps<HttpTypes.AdminOrder>) => {
  const { t } = useTranslation("printTrail")
  const prompt = usePrompt()
  const { data: view, isLoading } = useOrderView(order.id)
  const invalidate = useInvalidateOrder(order.id)

  const failed = (e: unknown) => {
    const { status, message } = errorOf(e)
    toast.error(status === 409 || status === 400 ? t(refusalKey(message), { defaultValue: message }) : t("common.error", { message }))
  }

  const refresh = useMutation({
    mutationFn: () => api.refresh(order.id),
    onSuccess: (r: RefreshResult) => {
      if (r.rows.some((x) => x.outcome === "busy")) toast.warning(t("order.busy"))
      else toast.success(r.changed ? t("order.updated") : t("order.noChanges"))
    },
    onError: failed,
    onSettled: invalidate,
  })
  const resend = useMutation({
    mutationFn: (body: { print_trail_order_id?: string; as_new?: boolean }) => api.resend(order.id, body),
    onSuccess: (r: ResendResult) => {
      if (!r.outcome) return toast.success(t(sendOutcomeKey("done")))
      const reason = r.reason ? t(attentionKey(r.reason).key, attentionKey(r.reason).values) : ""
      const message = t(sendOutcomeKey(r.outcome), { reason })
      if (r.outcome === "confirmed") toast.success(message)
      else if (r.outcome === "retrying" || r.outcome === "held") toast.warning(message)
      else toast.error(message)
    },
    onError: failed,
    onSettled: invalidate,
  })
  const dismiss = useMutation({
    mutationFn: (row: OrderRowView) => api.dismiss(order.id, { print_trail_order_id: row.id, attention: row.attention ?? "" }),
    onSuccess: (r: DismissResult) => (r.status === "dismissed" ? toast.success(t("order.dismissed")) : toast.info(t("order.dismissUnchanged"))),
    onError: failed,
    onSettled: invalidate,
  })
  const pending = refresh.isPending || resend.isPending || dismiss.isPending

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

  const m: Mutations = {
    pending,
    refresh: () => refresh.mutate(),
    resend: (row) => resend.mutate({ print_trail_order_id: row.id }),
    resendAsNew: async (row) => {
      const yes = await prompt({
        title: t("order.resendAsNewTitle"),
        description: t("order.resendAsNewBody", { number: row.pt_order_number, next: view.next_pt_order_number ?? "" }),
        confirmText: t("order.resendAsNew"),
        cancelText: t("common.cancel"),
        variant: "confirmation",
      })
      if (yes) resend.mutate({ print_trail_order_id: row.id, as_new: true })
    },
    dismiss: async (row) => {
      const l = attentionKey(row.attention ?? "")
      const yes = await prompt({
        title: t("order.dismissTitle"),
        description: t(dismissBodyKey(row.attention ?? ""), { label: t(l.key, l.values) }),
        confirmText: t("order.dismiss"),
        cancelText: t("common.cancel"),
        variant: "confirmation",
      })
      if (yes) dismiss.mutate(row)
    },
  }

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h2">{t("order.title")}</Heading>
      </div>
      {hasHealthNotices(view.health) && (
        <div className="px-6 py-4">
          <HealthNotices health={view.health} />
        </div>
      )}
      {view.expected && (
        <div className="flex items-center justify-between gap-2 px-6 py-4">
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {t("order.notSent")}
          </Text>
          <Button size="small" variant="secondary" onClick={() => resend.mutate({})} isLoading={resend.isPending} disabled={pending || view.canceled}>
            {t("order.sendNow")}
          </Button>
        </div>
      )}
      {view.rows.map((row) => (
        <RowBlock key={row.id} row={row} view={view} m={m} />
      ))}
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.side",
  id: "print-trail:order-summary",
})

export default OrderSummaryWidget
