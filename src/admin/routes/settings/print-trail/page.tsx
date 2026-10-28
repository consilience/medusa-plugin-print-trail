import { defineRouteConfig } from "@medusajs/admin-sdk"
import {
  Badge,
  Button,
  CodeBlock,
  Container,
  Heading,
  InlineTip,
  Table,
  Text,
  toast,
  Tooltip,
  usePrompt,
} from "@medusajs/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import type { ConnectionTestResult, ConnectionView, SkuHealthView } from "../../../../lib/admin-types"
import { hasHealthNotices, HealthNotices } from "../../../components/health-notices"
import { api, errorOf, keys } from "../../../lib/api"
import { CONFIG_SNIPPET, ENV_SNIPPET, formatDate } from "../../../lib/format"
import { confirmationSteps } from "../../../lib/webhook-confirm"
import {
  checkBadge,
  diagnosisHintKey,
  diagnosisKey,
  type Label,
  secretSourceKey,
  skuHealthFailed,
  stockSyncToast,
  stockSyncUnavailableKey,
  warningKey,
  webhookActionKey,
  webhookStateKey,
} from "../../../lib/labels"

type WebhookResult = ConnectionTestResult["webhook"]

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="grid grid-cols-2 items-start gap-4 px-6 py-3">
    <Text size="small" leading="compact" weight="plus">
      {label}
    </Text>
    <div className="text-ui-fg-subtle flex flex-wrap items-center gap-2 break-all">{children}</div>
  </div>
)

const Value = ({ children }: { children: React.ReactNode }) => (
  <Text size="small" leading="compact" className="text-ui-fg-subtle">
    {children}
  </Text>
)

const Section = ({ title, id, actions, children }: { title: string; id?: string; actions?: React.ReactNode; children: React.ReactNode }) => (
  <Container className="divide-y p-0" id={id}>
    <div className="flex items-center justify-between px-6 py-4">
      <Heading level="h2">{title}</Heading>
      {actions}
    </div>
    {children}
  </Container>
)

const ConnectionSection = ({ view, onTest, testing }: { view: ConnectionView; onTest: () => void; testing: boolean }) => {
  const { t } = useTranslation("printTrail")
  const d = view.diagnosis
  const hint = d.ok ? null : diagnosisHintKey(d.code, view.endpoint.environment)
  return (
    <Section
      title={t("settings.connection.heading")}
      actions={
        <Button size="small" variant="secondary" onClick={onTest} isLoading={testing} disabled={testing || !view.configured}>
          {t("settings.connection.test")}
        </Button>
      }
    >
      <Row label={t("settings.connection.heading")}>
        {d.ok ? (
          <Badge size="2xsmall" color="green">
            {t("settings.connection.connected")}
          </Badge>
        ) : (
          <>
            <Badge size="2xsmall" color="red">
              {t("settings.connection.notConnected")}
            </Badge>
            <Value>
              {t(diagnosisKey(d.code), {
                detail: d.detail ?? "",
                tokenChannelId: d.tokenChannelId ?? "",
                channelId: view.credentials.channelId ?? "",
              })}
              {hint && ` ${t(hint)}`}
            </Value>
          </>
        )}
      </Row>
      {view.channel && (
        <Row label={t("settings.connection.channel")}>
          <ExternalOrText text={view.channel.name ?? view.channel.code} url={view.channel.url} />
        </Row>
      )}
      {view.team && (
        <Row label={t("settings.connection.team")}>
          <ExternalOrText text={view.team.name ?? view.team.code} url={view.team.url} />
        </Row>
      )}
      <Row label={t("settings.connection.endpoint")}>
        <Value>{view.endpoint.url ?? t("common.notSet")}</Value>
        {view.endpoint.environment === "staging" && (
          <Badge size="2xsmall" color="orange">
            {t("settings.connection.staging")}
          </Badge>
        )}
        {view.endpoint.environment === "production" && (
          <Badge size="2xsmall" color="green">
            {t("settings.connection.production")}
          </Badge>
        )}
      </Row>
      <Row label={t("settings.apiVersion.label")}>
        <Value>
          {view.api_version
            ? t("settings.apiVersion.value", { version: view.api_version.version, at: formatDate(view.api_version.seen_at) })
            : t("settings.apiVersion.none")}
        </Value>
      </Row>
      <Row label={t("settings.connection.channelId")}>
        <Value>{view.credentials.channelId ?? t("common.notSet")}</Value>
      </Row>
      <Row label={t("settings.connection.token")}>
        <Value>
          {!view.credentials.apiToken.set
            ? t("common.notSet")
            : view.credentials.apiToken.ending
              ? t("settings.connection.tokenEnding", { ending: view.credentials.apiToken.ending })
              : t("settings.connection.tokenSet")}
        </Value>
      </Row>
      <div className="px-6 py-3">
        <Text size="small" leading="compact" className="text-ui-fg-subtle">
          {t("settings.restartHelp")}
        </Text>
      </div>
    </Section>
  )
}

const ExternalOrText = ({ text, url }: { text: string; url: string | null }) =>
  url ? (
    <Text size="small" leading="compact">
      <a href={url} target="_blank" rel="noreferrer" className="text-ui-fg-interactive hover:text-ui-fg-interactive-hover">
        {text}
      </a>
    </Text>
  ) : (
    <Value>{text}</Value>
  )

const WebhookSection = ({
  view,
  onRegister,
  registering,
  onRotate,
  rotating,
}: {
  view: ConnectionView
  onRegister: () => void
  registering: boolean
  onRotate: () => void
  rotating: boolean
}) => {
  const { t } = useTranslation("printTrail")
  const w = view.webhook
  const color = w.state === "registered" ? "green" : w.state === "elsewhere" || w.state === "not-registered" ? "orange" : "grey"
  return (
    <Section
      title={t("settings.webhook.heading")}
      actions={
        w.state === "elsewhere" || w.state === "not-registered" ? (
          <Button size="small" variant="secondary" onClick={onRegister} isLoading={registering} disabled={registering}>
            {t("settings.webhook.reregister")}
          </Button>
        ) : w.state === "registered" ? (
          <Button size="small" variant="secondary" onClick={onRotate} isLoading={rotating} disabled={rotating || registering}>
            {t("settings.webhook.rotate")}
          </Button>
        ) : null
      }
    >
      <Row label={t("settings.webhook.state")}>
        <Badge size="2xsmall" color={color}>
          {t(webhookStateKey(w.state))}
        </Badge>
      </Row>
      <Row label={t("settings.webhook.registeredUrl")}>
        <Value>{w.registeredUrl ?? t("common.none")}</Value>
      </Row>
      <Row label={t("settings.webhook.targetUrl")}>
        <Value>{w.targetUrl ?? t("common.notSet")}</Value>
      </Row>
      {w.warnings.length > 0 && (
        <div className="flex flex-col gap-2 px-6 py-3">
          {w.warnings.map((warning) => (
            <InlineTip key={warning} variant="warning" label={t("settings.webhook.heading")}>
              {t(warningKey(warning))}
            </InlineTip>
          ))}
        </div>
      )}
      <Row label={t("settings.webhook.secret")}>
        <Badge size="2xsmall" color={view.credentials.webhookSecret.set ? "green" : "red"}>
          {t(secretSourceKey(view.credentials.webhookSecret.source))}
        </Badge>
      </Row>
      <div className="px-6 py-3">
        <Text size="small" leading="compact" className="text-ui-fg-subtle">
          {t("settings.secretHelp")}
        </Text>
      </div>
    </Section>
  )
}

const MethodsSection = ({ view }: { view: ConnectionView }) => {
  const { t } = useTranslation("printTrail")
  return (
    <Section
      title={t("settings.methods.heading")}
      actions={
        <Button size="small" variant="secondary" asChild>
          <Link to="/settings/print-trail/shipping">{t("settings.methods.manage")}</Link>
        </Button>
      }
    >
      <div className="flex flex-col gap-2 px-6 py-4">
        <Text size="small" leading="compact" className="text-ui-fg-subtle">
          {view.shippingMethodsSource === "print-trail" ? t("settings.methods.fromPrintTrail") : t("settings.methods.fallback")}
        </Text>
        <div className="flex flex-wrap gap-2">
          {view.shippingMethods.map((m) => (
            <Badge key={m.code} size="2xsmall" color="grey">
              {m.name} ({m.code})
            </Badge>
          ))}
        </div>
      </div>
    </Section>
  )
}

// "Sync stock now": a full stock sync, waited for. Turned off with the
// stock sync, or when SKU health couldn't be loaded, with the reason as its
// tooltip.
const SyncStockButton = ({
  health,
  loadFailed,
  onSync,
  syncing,
}: {
  health: SkuHealthView | undefined
  loadFailed: Label | null
  onSync: () => void
  syncing: boolean
}) => {
  const { t } = useTranslation("printTrail")
  const unavailable = health !== undefined && !health.stockSyncEnabled
  const reason = loadFailed ? t(loadFailed.key, loadFailed.values) : unavailable ? t(stockSyncUnavailableKey) : null
  const button = (
    <Button size="small" variant="secondary" onClick={onSync} isLoading={syncing} disabled={syncing || !health || unavailable}>
      {t("settings.sku.syncNow.button")}
    </Button>
  )
  return reason ? (
    <Tooltip content={reason}>
      <span>{button}</span>
    </Tooltip>
  ) : (
    button
  )
}

const SkuHealthSection = ({
  health,
  loading,
  loadFailed,
  onSync,
  syncing,
}: {
  health: SkuHealthView | undefined
  loading: boolean
  loadFailed: Label | null
  onSync: () => void
  syncing: boolean
}) => {
  const { t } = useTranslation("printTrail")
  const run = health?.lastRun ?? null
  return (
    <Section
      title={t("settings.sku.heading")}
      id="sku-health"
      actions={<SyncStockButton health={health} loadFailed={loadFailed} onSync={onSync} syncing={syncing} />}
    >
      {loading || !health ? (
        <div className="px-6 py-4">
          <Text size="small" className="text-ui-fg-subtle">
            {loadFailed ? t(loadFailed.key, loadFailed.values) : t("common.loading")}
          </Text>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2 px-6 py-4">
            <Text size="small" leading="compact" weight="plus">
              {t("settings.sku.unmatched")}
            </Text>
            {health.unmatched.length ? (
              <div className="flex flex-wrap gap-2">
                {health.unmatched.map((sku) => (
                  <Badge key={sku} size="2xsmall" color="red">
                    {sku}
                  </Badge>
                ))}
              </div>
            ) : (
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                {t("settings.sku.noUnmatched")}
              </Text>
            )}
          </div>
          <div className="flex flex-col gap-2 px-6 py-4">
            <Text size="small" leading="compact" weight="plus">
              {t("settings.sku.problems")}
            </Text>
            {health.problems.length ? (
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>{t("settings.sku.product")}</Table.HeaderCell>
                    <Table.HeaderCell>{t("settings.sku.variant")}</Table.HeaderCell>
                    <Table.HeaderCell>{t("settings.sku.sku")}</Table.HeaderCell>
                    <Table.HeaderCell>{t("settings.sku.status")}</Table.HeaderCell>
                    <Table.HeaderCell>{t("settings.sku.checkedAt")}</Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {health.problems.map((p) => {
                    const badge = checkBadge(p, true)
                    return (
                      <Table.Row key={p.variant_id}>
                        <Table.Cell>{p.product_title ?? p.product_id}</Table.Cell>
                        <Table.Cell>
                          <Link
                            to={`/products/${p.product_id}/variants/${p.variant_id}`}
                            className="text-ui-fg-interactive hover:text-ui-fg-interactive-hover"
                          >
                            {p.variant_title ?? p.variant_id}
                          </Link>
                        </Table.Cell>
                        <Table.Cell>{p.sku ?? t("variant.noSku")}</Table.Cell>
                        <Table.Cell>
                          <Badge size="2xsmall" color={badge.color}>
                            {t(badge.key)}
                          </Badge>
                        </Table.Cell>
                        <Table.Cell>{formatDate(p.checked_at)}</Table.Cell>
                      </Table.Row>
                    )
                  })}
                </Table.Body>
              </Table>
            ) : (
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                {t("settings.sku.noProblems")}
              </Text>
            )}
            {health.unchecked > 0 && (
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                {t("settings.sku.unchecked", { count: health.unchecked })}
              </Text>
            )}
            {health.truncated && (
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                {t("settings.sku.truncated")}
              </Text>
            )}
          </div>
          <div className="flex flex-col gap-2 px-6 py-4">
            <Text size="small" leading="compact" weight="plus">
              {t("settings.sku.lastRun")}
            </Text>
            {!health.stockSyncEnabled && (
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                {t("settings.sku.stockSyncOff")}
              </Text>
            )}
            {run ? (
              <>
                <Text size="small" leading="compact" className="text-ui-fg-subtle">
                  {t("settings.sku.lastRunSummary", {
                    trigger: run.trigger,
                    at: formatDate(run.completedAt),
                    levels: run.levelsUpdated,
                    skipped: run.skipped.length,
                  })}
                </Text>
                {run.error && (
                  <InlineTip variant="error" label={t("settings.sku.lastRun")}>
                    {t("settings.sku.lastRunError", { error: run.error })}
                  </InlineTip>
                )}
                {run.warnings.map((w) => (
                  <InlineTip key={w.type} variant="warning" label={t("settings.sku.lastRun")}>
                    {t(`settings.sku.warning.${w.type}`, { skus: w.skus.join(", "), defaultValue: w.type })}
                  </InlineTip>
                ))}
              </>
            ) : (
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                {t("settings.sku.lastRunNever")}
              </Text>
            )}
          </div>
        </>
      )}
    </Section>
  )
}

const OptionsSection = ({ view }: { view: ConnectionView }) => {
  const { t } = useTranslation("printTrail")
  const o = view.options
  const onOff = (v: boolean) => (v ? t("settings.options.on") : t("settings.options.off"))
  const template = (v: string | false) => (v === false ? t("settings.options.off") : v)
  return (
    <Section title={t("settings.options.heading")}>
      <div className="px-6 py-3">
        <Text size="small" leading="compact" className="text-ui-fg-subtle">
          {t("settings.options.help")}
        </Text>
      </div>
      <Row label={t("settings.options.orderNumberPrefix")}>
        <Value>{o.orderNumberPrefix || t("common.none")}</Value>
      </Row>
      <Row label={t("settings.options.defaultShippingMethod")}>
        <Value>{o.defaultShippingMethod}</Value>
      </Row>
      <Row label={t("settings.options.confirmOn")}>
        <Value>{o.confirmOn}</Value>
      </Row>
      <Row label={t("settings.options.strictSkus")}>
        <Value>{onOff(o.strictSkus)}</Value>
      </Row>
      <Row label={t("settings.options.stockSync")}>
        <Value>{onOff(o.stockSync)}</Value>
      </Row>
      <Row label={t("settings.options.reconcile")}>
        <Value>{o.reconcile.enabled ? t("settings.options.reconcileValue", { days: o.reconcile.lookbackDays }) : onOff(false)}</Value>
      </Row>
      <Row label={t("settings.options.autoComplete")}>
        <Value>{onOff(o.autoComplete)}</Value>
      </Row>
      <Row label={t("settings.options.shipmentEmail")}>
        <Value>{template(o.notifications.shipment)}</Value>
      </Row>
      <Row label={t("settings.options.cancelTooLateEmail")}>
        <Value>{template(o.notifications.cancelTooLate)}</Value>
      </Row>
      <Row label={t("settings.options.adminEmails")}>
        <Value>
          {o.notifications.adminEmailCount
            ? t("settings.options.adminEmailCount", { count: o.notifications.adminEmailCount })
            : t("common.notSet")}
        </Value>
      </Row>
      <Row label={t("settings.options.stockLocations")}>
        <Value>{o.stockLocationIds?.length ? o.stockLocationIds.join(", ") : t("settings.options.allLocations")}</Value>
      </Row>
      <Row label={t("settings.options.appUrl")}>
        <Value>{o.appUrl ?? t("common.default")}</Value>
      </Row>
      <Row label={t("settings.options.adminUrl")}>
        <Value>{o.adminUrl ?? t("common.notSet")}</Value>
      </Row>
      <Row label={t("settings.options.backendUrl")}>
        <Value>{o.backendUrl ?? t("common.notSet")}</Value>
      </Row>
      <Row label={t("settings.options.locking")}>
        <Value>{view.locking?.provider ?? t("common.none")}</Value>
      </Row>
      <div className="px-6 py-4">
        <Text size="small" leading="compact" weight="plus" className="mb-2">
          {t("settings.options.schedules")}
        </Text>
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{t("settings.options.job")}</Table.HeaderCell>
              <Table.HeaderCell>{t("settings.options.variable")}</Table.HeaderCell>
              <Table.HeaderCell>{t("settings.options.schedule")}</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {view.schedules.map((s) => (
              <Table.Row key={s.job}>
                <Table.Cell>{s.job}</Table.Cell>
                <Table.Cell>{s.variable}</Table.Cell>
                <Table.Cell>
                  <div className="flex items-center gap-2">
                    {s.schedule}
                    {s.isDefault && (
                      <Badge size="2xsmall" color="grey">
                        {t("common.default")}
                      </Badge>
                    )}
                  </div>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </div>
    </Section>
  )
}

const EmptyState = ({ view }: { view: ConnectionView }) => {
  const { t } = useTranslation("printTrail")
  return (
    <Section title={t("settings.empty.heading")}>
      <div className="flex flex-col gap-4 px-6 py-4">
        <Text size="small" leading="compact" className="text-ui-fg-subtle">
          {t("settings.empty.body")}
        </Text>
        <CodeBlock
          snippets={[
            { label: t("settings.empty.variables"), language: "bash", code: ENV_SNIPPET },
            { label: t("settings.empty.config"), language: "tsx", code: CONFIG_SNIPPET },
          ]}
        >
          <CodeBlock.Header />
          <CodeBlock.Body />
        </CodeBlock>
        {view.warnings.includes("no-print-trail-shipping-options") && (
          <Link to="/settings/print-trail/shipping" className="text-ui-fg-interactive hover:text-ui-fg-interactive-hover txt-compact-small">
            {t("settings.empty.addOption")}
          </Link>
        )}
      </div>
    </Section>
  )
}

const SettingsPage = () => {
  const { t } = useTranslation("printTrail")
  const queryClient = useQueryClient()
  const prompt = usePrompt()
  // Display queries load on mount: the automatic, read-only check.
  const connection = useQuery({ queryKey: keys.connection, queryFn: () => api.connection() })
  const skuHealth = useQuery({ queryKey: keys.skuHealth, queryFn: () => api.skuHealth() })

  const refreshViews = () => queryClient.invalidateQueries({ queryKey: keys.connection })

  const register = useMutation({
    mutationFn: (force: boolean) => api.registerWebhook(force),
    onSettled: refreshViews,
  })

  // Another address (never taken over without asking) or an unsafe target
  // (plain http, a local address, which Print Trail API 1.2.0 refuses outside
  // development) is registered only after the admin says yes to each prompt;
  // the yes re-runs the registration with force.
  const handleWebhookResult = async (result: WebhookResult) => {
    const steps = confirmationSteps(result)
    if (!steps.length) return notify(result)
    for (const step of steps) {
      const yes = await prompt(
        step === "elsewhere"
          ? {
              title: t("webhook.confirmElsewhereTitle"),
              description: t("webhook.confirmElsewhere", { url: result.registeredUrl ?? connection.data?.webhook.registeredUrl ?? "" }),
              confirmText: t("webhook.confirmElsewhereYes"),
              cancelText: t("common.cancel"),
              variant: "confirmation",
            }
          : {
              title: t("webhook.confirmTitle"),
              description: t("webhook.confirmUnsafe", { url: connection.data?.webhook.targetUrl ?? "" }),
              confirmText: t("webhook.confirmYes"),
              cancelText: t("common.cancel"),
              variant: "confirmation",
            }
      )
      if (!yes) return toast.info(t("webhook.actions.needs-confirmation"))
    }
    try {
      notify(await register.mutateAsync(true))
    } catch (e) {
      toast.error(t("common.error", { message: errorOf(e).message }))
    }
  }

  const notify = (result: WebhookResult) => {
    if (result.detail === "secret-not-stored") return toast.warning(t("settings.webhook.secretNotStored"))
    if (result.action === "busy") return toast.info(t(webhookActionKey(result.action)))
    const message = t(webhookActionKey(result.action), { detail: result.detail ?? "" })
    if (result.action === "failed" || result.action === "cannot-register" || result.action === "invalid-url") toast.error(message)
    else toast.success(message)
  }

  const test = useMutation({
    mutationFn: () => api.testConnection(),
    onSuccess: async (result) => {
      if (!result.diagnosis.ok) {
        const hint = diagnosisHintKey(result.diagnosis.code, connection.data?.endpoint.environment)
        toast.error(
          t(diagnosisKey(result.diagnosis.code), {
            detail: result.diagnosis.detail ?? "",
            tokenChannelId: result.diagnosis.tokenChannelId ?? "",
            channelId: connection.data?.credentials.channelId ?? "",
          }) + (hint ? ` ${t(hint)}` : "")
        )
        return
      }
      await handleWebhookResult(result.webhook)
    },
    onError: (e) => toast.error(t("common.error", { message: errorOf(e).message })),
    onSettled: () => {
      refreshViews()
      queryClient.invalidateQueries({ queryKey: keys.skuHealth })
    },
  })

  const rotate = useMutation({
    mutationFn: () => api.rotateWebhookSecret(),
    onSettled: refreshViews,
  })

  const rotateSecret = async () => {
    const yes = await prompt({
      title: t("settings.webhook.rotateTitle"),
      description: t("settings.webhook.rotateBody"),
      confirmText: t("settings.webhook.rotateYes"),
      cancelText: t("common.cancel"),
      variant: "confirmation",
    })
    if (!yes) return
    try {
      const result = await rotate.mutateAsync()
      const message =
        result.detail === "secret-not-stored"
          ? t("settings.webhook.rotated.secret-not-stored")
          : t(`settings.webhook.rotated.${result.action}`, { detail: result.detail ?? "" })
      if (result.action === "rotated") toast.success(message)
      else if (result.action === "busy") toast.info(message)
      else toast.error(message)
    } catch (e) {
      toast.error(t("common.error", { message: errorOf(e).message }))
    }
  }

  // The request waits for the run. A long one behind a proxy can time out
  // here while it finishes on the server: the last run shows the outcome.
  const syncStock = useMutation({
    mutationFn: () => api.syncStockNow(),
    onSuccess: (result) => {
      const label = stockSyncToast(result)
      toast[label.variant](t(label.key, label.values))
    },
    onError: (e) => toast.error(t("settings.sku.syncNow.requestFailed", { message: errorOf(e).message })),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.skuHealth }),
  })

  const reregister = async () => {
    try {
      await handleWebhookResult(await register.mutateAsync(false))
    } catch (e) {
      toast.error(t("common.error", { message: errorOf(e).message }))
    }
  }

  const view = connection.data
  return (
    <div className="flex flex-col gap-y-3">
      <Container className="px-6 py-4">
        <Heading level="h1">{t("settings.title")}</Heading>
        <Text size="small" leading="compact" className="text-ui-fg-subtle mt-1">
          {t("settings.description")}
        </Text>
      </Container>
      {connection.isLoading || !view ? (
        <Container className="px-6 py-4">
          <Text size="small" className="text-ui-fg-subtle">
            {connection.isError ? t("common.error", { message: errorOf(connection.error).message }) : t("common.loading")}
          </Text>
        </Container>
      ) : (
        <>
          {(hasHealthNotices(view.health) || view.warnings.length > 0) && (
            <Container className="flex flex-col gap-2 px-6 py-4">
              <HealthNotices health={view.health} />
              {view.warnings.map((w) => (
                <InlineTip
                  key={w}
                  variant={w === "postgres-locking" || w === "not-configured" ? "error" : "warning"}
                  label={t("settings.notices")}
                >
                  {t(warningKey(w))}
                </InlineTip>
              ))}
            </Container>
          )}
          {!view.configured && <EmptyState view={view} />}
          <ConnectionSection view={view} onTest={() => test.mutate()} testing={test.isPending} />
          <WebhookSection
            view={view}
            onRegister={reregister}
            registering={register.isPending || test.isPending}
            onRotate={rotateSecret}
            rotating={rotate.isPending}
          />
          <MethodsSection view={view} />
          <SkuHealthSection
            health={skuHealth.data}
            loading={skuHealth.isLoading}
            loadFailed={skuHealth.isError && !skuHealth.data ? skuHealthFailed(errorOf(skuHealth.error).message) : null}
            onSync={() => syncStock.mutate()}
            syncing={syncStock.isPending}
          />
          <OptionsSection view={view} />
        </>
      )}
    </div>
  )
}

export const config = defineRouteConfig({
  label: "settings.title",
  translationNs: "printTrail",
})

export default SettingsPage
