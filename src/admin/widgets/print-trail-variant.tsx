import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { DetailWidgetProps, HttpTypes } from "@medusajs/framework/types"
import { Badge, Button, Container, Drawer, Heading, Input, Label, Text, toast } from "@medusajs/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { api, errorOf, keys } from "../lib/api"
import { formatDay } from "../lib/format"
import { checkBadge } from "../lib/labels"
import { sdk } from "../lib/sdk"
import { variantOverridePayload } from "../lib/variant-form"

const MAX_POLLS = 10

const VariantWidget = ({ data: variant }: DetailWidgetProps<HttpTypes.AdminProductVariant>) => {
  const { t } = useTranslation("printTrail")
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState("")
  const polls = useRef(0)
  const productId = variant.product_id ?? ""

  const { data: view, isLoading, refetch, dataUpdatedAt } = useQuery({
    queryKey: keys.variant(variant.id),
    queryFn: () => api.variant(variant.id),
  })

  // The SKU check runs after a save: poll every 3 s until it's current, at
  // most MAX_POLLS times. Each fetch schedules the next one.
  useEffect(() => {
    if (!view?.in_print_trail_profile || view.check_current || polls.current >= MAX_POLLS) return
    const timer = setTimeout(() => {
      polls.current++
      refetch()
    }, 3000)
    return () => clearTimeout(timer)
  }, [dataUpdatedAt, view?.in_print_trail_profile, view?.check_current, refetch])

  useEffect(() => {
    if (open) setValue(view?.override ?? "")
  }, [open, view?.override])

  const save = useMutation({
    mutationFn: async (input: string) => {
      // Medusa before 2.19 replaces a variant's metadata on update: read it
      // fresh and send it whole, with only the override changed.
      const { variant: current } = await sdk.admin.product.retrieveVariant(productId, variant.id, { fields: "id,metadata" })
      return sdk.admin.product.updateVariant(productId, variant.id, variantOverridePayload(current.metadata ?? null, input))
    },
    onSuccess: () => {
      toast.success(t("variant.saved"))
      polls.current = 0
      queryClient.invalidateQueries({ queryKey: keys.variant(variant.id) })
      queryClient.invalidateQueries({ queryKey: ["product_variant"] })
      queryClient.invalidateQueries({ queryKey: ["product_variants"] })
      queryClient.invalidateQueries({ queryKey: ["products"] })
      queryClient.invalidateQueries({ queryKey: keys.skuHealth })
      setOpen(false)
    },
    onError: (e) => toast.error(t("common.error", { message: errorOf(e).message })),
  })

  if (isLoading || !view) {
    return (
      <Container className="px-6 py-4">
        <Text size="small" className="text-ui-fg-subtle">
          {t("common.loading")}
        </Text>
      </Container>
    )
  }

  const badge = checkBadge(view.check, view.check_current)
  const stock = view.stock
  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h2">{t("variant.title")}</Heading>
        <Button size="small" variant="secondary" onClick={() => setOpen(true)} disabled={save.isPending}>
          {t("variant.edit")}
        </Button>
      </div>
      {!view.in_print_trail_profile && (
        <div className="px-6 py-4">
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {t("variant.notInProfile")}
          </Text>
        </div>
      )}
      <div className="grid grid-cols-2 items-start gap-4 px-6 py-4">
        <Text size="small" leading="compact" weight="plus">
          {t("variant.sku")}
        </Text>
        <div className="flex flex-col gap-1">
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {view.override ?? t("variant.usesVariantSku")}
          </Text>
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {view.resolved_sku ? t("variant.resolved", { sku: view.resolved_sku }) : t("variant.noSku")}
          </Text>
          {view.in_print_trail_profile && (
            <Badge size="2xsmall" color={badge.color} className="w-fit">
              {t(badge.key)}
            </Badge>
          )}
          {view.check?.note === "numeric-override" && (
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {t("variant.numericOverride")}
            </Text>
          )}
        </div>
      </div>
      <div className="px-6 py-4">
        <Text size="small" leading="compact" className="text-ui-fg-subtle">
          {!stock.manage_inventory
            ? t("variant.stock.notManaged")
            : stock.print_on_demand
              ? t("variant.stock.printOnDemand", { available: stock.available ?? 0 })
              : t("variant.stock.inStock", { available: stock.available ?? 0 })}
        </Text>
        {stock.pre_order && (
          <div className="mt-2 flex flex-col gap-1">
            <Badge size="2xsmall" color="blue" className="w-fit">
              {t(stock.pre_order_backorder ? "variant.stock.preOrder" : "variant.stock.preOrderOwn")}
            </Badge>
            {stock.publication_date && (
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                {t("variant.preOrderDate", { date: formatDay(stock.publication_date) })}
              </Text>
            )}
            {stock.pre_order_limit !== null ? (
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                {t("variant.preOrderLimit", { limit: stock.pre_order_limit, remaining: stock.pre_order_remaining ?? 0 })}
              </Text>
            ) : (
              stock.pre_order_backorder && (
                <Text size="small" leading="compact" className="text-ui-fg-subtle">
                  {t("variant.preOrderUnlimited")}
                </Text>
              )
            )}
          </div>
        )}
      </div>

      <Drawer open={open} onOpenChange={(o) => !save.isPending && setOpen(o)}>
        <Drawer.Content>
          <Drawer.Header>
            <Drawer.Title>{t("variant.editTitle")}</Drawer.Title>
          </Drawer.Header>
          <Drawer.Body className="flex flex-col gap-y-2">
            <Label size="small" weight="plus" htmlFor="pt-sku-override">
              {t("variant.override")}
            </Label>
            <Input id="pt-sku-override" size="small" value={value} placeholder={view.sku ?? ""} disabled={save.isPending} onChange={(e) => setValue(e.target.value)} />
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {t("variant.hint")}
            </Text>
          </Drawer.Body>
          <Drawer.Footer>
            <Drawer.Close asChild>
              <Button size="small" variant="secondary" disabled={save.isPending}>
                {t("common.cancel")}
              </Button>
            </Drawer.Close>
            <Button size="small" onClick={() => save.mutate(value)} isLoading={save.isPending} disabled={save.isPending || !productId}>
              {t("common.save")}
            </Button>
          </Drawer.Footer>
        </Drawer.Content>
      </Drawer>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "product_variant.details",
  id: "print-trail:variant-sku",
})

export default VariantWidget
