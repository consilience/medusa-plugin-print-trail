import { EllipsisHorizontal, PencilSquare, Trash } from "@medusajs/icons"
import {
  Badge,
  Button,
  Container,
  Drawer,
  DropdownMenu,
  FocusModal,
  Heading,
  IconButton,
  Table,
  Text,
  toast,
  usePrompt,
} from "@medusajs/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import type { ShippingOptionChoices, ShippingOptionView } from "../../../../../lib/admin-types"
import { CountryBands } from "../../../../components/country-bands"
import { RateCardEditor } from "../../../../components/rate-card-editor"
import { api, errorOf, keys } from "../../../../lib/api"
import { formatPrice } from "../../../../lib/format"
import { describeBands, emptyForm, formToRateCard, rateCardToForm, type RateCardForm } from "../../../../lib/rate-card-form"

const BandSummary = ({ option }: { option: ShippingOptionView }) => {
  const { t } = useTranslation("printTrail")
  if (!option.rate_card || option.card_issue) {
    return (
      <Badge size="2xsmall" color={option.card_issue === "invalid" ? "red" : "orange"}>
        {option.card_issue === "invalid" ? t("shipping.invalidCard") : t("shipping.noCard")}
      </Badge>
    )
  }
  const currency = option.rate_card.currency_code
  return (
    <div className="flex flex-col">
      {describeBands(option.rate_card).map((b, i) => (
        <Text key={i} size="xsmall" leading="compact" className="text-ui-fg-subtle">
          {b.upTo === null
            ? t("shipping.bandOpen", { from: b.from, price: formatPrice(b.price, currency) })
            : t("shipping.band", { from: b.from, upTo: b.upTo, price: formatPrice(b.price, currency) })}
        </Text>
      ))}
      <CountryBands card={option.rate_card} />
    </div>
  )
}

const useInvalidate = () => {
  const queryClient = useQueryClient()
  return () => {
    queryClient.invalidateQueries({ queryKey: keys.shippingOptions })
    queryClient.invalidateQueries({ queryKey: keys.connection })
  }
}

const CreateModal = ({ choices }: { choices: ShippingOptionChoices }) => {
  const { t } = useTranslation("printTrail")
  const invalidate = useInvalidate()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<RateCardForm>(emptyForm())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const create = useMutation({
    mutationFn: api.createShippingOption,
    onSuccess: () => {
      toast.success(t("shipping.created"))
      invalidate()
      setOpen(false)
      setForm(emptyForm())
    },
    onError: (e) => toast.error(t("common.error", { message: errorOf(e).message })),
  })
  const submit = () => {
    const result = formToRateCard(form)
    if (!result.ok) return setErrors(result.errors)
    setErrors({})
    create.mutate(result.body)
  }
  return (
    <FocusModal open={open} onOpenChange={(o) => !create.isPending && setOpen(o)}>
      <FocusModal.Trigger asChild>
        <Button size="small" variant="secondary">
          {t("shipping.create")}
        </Button>
      </FocusModal.Trigger>
      <FocusModal.Content>
        <FocusModal.Header>
          <div className="flex items-center justify-end gap-x-2">
            <FocusModal.Close asChild>
              <Button size="small" variant="secondary" disabled={create.isPending}>
                {t("common.cancel")}
              </Button>
            </FocusModal.Close>
            <Button size="small" onClick={submit} isLoading={create.isPending} disabled={create.isPending}>
              {t("common.create")}
            </Button>
          </div>
        </FocusModal.Header>
        <FocusModal.Body className="flex flex-1 flex-col items-center overflow-y-auto py-16">
          <div className="flex w-full max-w-[720px] flex-col gap-y-6">
            <Heading level="h2">{t("shipping.createTitle")}</Heading>
            <RateCardEditor form={form} onChange={setForm} errors={errors} choices={choices} disabled={create.isPending} />
          </div>
        </FocusModal.Body>
      </FocusModal.Content>
    </FocusModal>
  )
}

const EditDrawer = ({
  option,
  choices,
  onClose,
}: {
  option: ShippingOptionView
  choices: ShippingOptionChoices
  onClose: () => void
}) => {
  const { t } = useTranslation("printTrail")
  const invalidate = useInvalidate()
  const [form, setForm] = useState<RateCardForm>(rateCardToForm(option))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const update = useMutation({
    mutationFn: (body: Parameters<typeof api.updateShippingOption>[1]) => api.updateShippingOption(option.id, body),
    onSuccess: () => {
      toast.success(t("shipping.updated"))
      invalidate()
      onClose()
    },
    onError: (e) => toast.error(t("common.error", { message: errorOf(e).message })),
  })
  const submit = () => {
    const result = formToRateCard(form)
    if (!result.ok) return setErrors(result.errors)
    setErrors({})
    update.mutate({ name: result.body.name, rate_card: result.body.rate_card })
  }
  return (
    <Drawer open onOpenChange={(o) => !o && !update.isPending && onClose()}>
      <Drawer.Content>
        <Drawer.Header>
          <Drawer.Title>{t("shipping.editTitle")}</Drawer.Title>
        </Drawer.Header>
        <Drawer.Body className="overflow-y-auto">
          <RateCardEditor form={form} onChange={setForm} errors={errors} choices={choices} scopeLocked disabled={update.isPending} />
        </Drawer.Body>
        <Drawer.Footer>
          <Drawer.Close asChild>
            <Button size="small" variant="secondary" disabled={update.isPending}>
              {t("common.cancel")}
            </Button>
          </Drawer.Close>
          <Button size="small" onClick={submit} isLoading={update.isPending} disabled={update.isPending}>
            {t("common.save")}
          </Button>
        </Drawer.Footer>
      </Drawer.Content>
    </Drawer>
  )
}

const ShippingPage = () => {
  const { t } = useTranslation("printTrail")
  const prompt = usePrompt()
  const invalidate = useInvalidate()
  const [editing, setEditing] = useState<ShippingOptionView | null>(null)
  const { data, isLoading, isError, error } = useQuery({ queryKey: keys.shippingOptions, queryFn: () => api.shippingOptions() })
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteShippingOption(id),
    onSuccess: () => {
      toast.success(t("shipping.deleted"))
      invalidate()
    },
    onError: (e) => toast.error(t("common.error", { message: errorOf(e).message })),
  })
  const confirmDelete = async (option: ShippingOptionView) => {
    const yes = await prompt({
      title: t("shipping.deleteTitle", { name: option.name }),
      description: t("shipping.deleteBody"),
      confirmText: t("common.delete"),
      cancelText: t("common.cancel"),
    })
    if (yes) remove.mutate(option.id)
  }

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h1">{t("shipping.title")}</Heading>
          <Text size="small" leading="compact" className="text-ui-fg-subtle mt-1">
            {t("shipping.description")}
          </Text>
          <Link to="/settings/print-trail" className="text-ui-fg-interactive hover:text-ui-fg-interactive-hover txt-compact-small">
            {t("shipping.back")}
          </Link>
        </div>
        {data && <CreateModal choices={data.choices} />}
      </div>
      {isLoading || !data ? (
        <div className="px-6 py-4">
          <Text size="small" className="text-ui-fg-subtle">
            {isError ? t("common.error", { message: errorOf(error).message }) : t("common.loading")}
          </Text>
        </div>
      ) : data.shipping_options.length === 0 ? (
        <div className="px-6 py-4">
          <Text size="small" className="text-ui-fg-subtle">
            {t("shipping.empty")}
          </Text>
        </div>
      ) : (
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{t("shipping.name")}</Table.HeaderCell>
              <Table.HeaderCell>{t("shipping.serviceZone")}</Table.HeaderCell>
              <Table.HeaderCell>{t("shipping.profile")}</Table.HeaderCell>
              <Table.HeaderCell>{t("shipping.method")}</Table.HeaderCell>
              <Table.HeaderCell>{t("shipping.currency")}</Table.HeaderCell>
              <Table.HeaderCell>{t("shipping.bands")}</Table.HeaderCell>
              <Table.HeaderCell />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {data.shipping_options.map((o) => (
              <Table.Row key={o.id}>
                <Table.Cell>{o.name}</Table.Cell>
                <Table.Cell>
                  {o.service_zone ? (o.service_zone.location ? `${o.service_zone.name} (${o.service_zone.location})` : o.service_zone.name) : ""}
                </Table.Cell>
                <Table.Cell>{o.shipping_profile?.name ?? ""}</Table.Cell>
                <Table.Cell>{o.rate_card?.method ?? ""}</Table.Cell>
                <Table.Cell>{o.rate_card?.currency_code.toUpperCase() ?? ""}</Table.Cell>
                <Table.Cell>
                  <BandSummary option={o} />
                </Table.Cell>
                <Table.Cell>
                  <DropdownMenu>
                    <DropdownMenu.Trigger asChild>
                      <IconButton size="small" variant="transparent" disabled={remove.isPending}>
                        <EllipsisHorizontal />
                      </IconButton>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content>
                      <DropdownMenu.Item className="gap-x-2" onClick={() => setEditing(o)}>
                        <PencilSquare className="text-ui-fg-subtle" />
                        {t("common.edit")}
                      </DropdownMenu.Item>
                      <DropdownMenu.Separator />
                      <DropdownMenu.Item className="gap-x-2" onClick={() => confirmDelete(o)}>
                        <Trash className="text-ui-fg-subtle" />
                        {t("common.delete")}
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}
      {editing && data && <EditDrawer key={editing.id} option={editing} choices={data.choices} onClose={() => setEditing(null)} />}
    </Container>
  )
}

export default ShippingPage
