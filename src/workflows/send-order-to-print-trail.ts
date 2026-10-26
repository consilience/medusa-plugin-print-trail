import { orderLock } from "../lib/order-lock"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import {
  createHook,
  createWorkflow,
  transform,
  when,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import type { GraphOrder, SelectedLine } from "../lib/lines"
import { scopedLines } from "../lib/order-scope"
import type { PtCreateOrderRequest } from "../modules/printTrail/client/types"
import {
  SEND_LOCK_TTL_SECONDS,
  type ConfirmOutcome,
  type CreateOutcome,
  type GateOutcome,
} from "../lib/send-flow"
import { confirmPrintTrailOrderStep } from "./steps/confirm-print-trail-order"
import { createPrintTrailDraftStep } from "./steps/create-print-trail-draft"
import { emitPrintTrailEventsStep } from "./steps/emit-print-trail-events"
import { loadOrderForPrintTrailStep } from "./steps/load-order-for-print-trail"
import { preparePrintTrailPayloadStep } from "./steps/prepare-print-trail-payload"
import { resolvePrintTrailTargetStep } from "./steps/resolve-print-trail-target"
import { printTrailConfirmGateStep } from "./steps/print-trail-confirm-gate"
import { recordPrintTrailSendOutcomeStep } from "./steps/record-print-trail-send-outcome"

export type SendOrderToPrintTrailInput = {
  order_id: string
  // A row by sequence (1 is the order itself). Retries and "Resend" use it.
  sequence?: number
  // A row by what it carries: "claim:{id}", "exchange:{id}".
  source_ref?: string
  // "Resend as a new Print Trail order" for row n, which Print Trail cancelled.
  reissue_of?: number
  // None of the three: sequence 1 until Print Trail has it confirmed, then a
  // "-n" order of whatever no row has sent (released pre-orders).

  // Seconds to wait for the per-order lock (admin actions: 0).
  lock_timeout?: number
}

export const sendOrderToPrintTrailWorkflowId = "send-order-to-print-trail"

// Sends a Medusa order's Print Trail lines as a draft and confirms it when the
// gate allows. Run by the order.placed and claim/exchange subscribers, the
// sweep job, retries and "Resend". Print Trail refusals are recorded results,
// not failures.
export const sendOrderToPrintTrailWorkflow = createWorkflow(
  sendOrderToPrintTrailWorkflowId,
  function (input: SendOrderToPrintTrailInput) {
    const lockKey = transform({ input }, ({ input }) => `print-trail:order:${input.order_id}`)
    acquireLockStep(transform({ input }, ({ input }) => orderLock(input.order_id, input.lock_timeout, SEND_LOCK_TTL_SECONDS)))

    const loaded = loadOrderForPrintTrailStep({ order_id: input.order_id })

    const request = transform({ input }, ({ input }) => ({
      sequence: input.sequence,
      source_ref: input.source_ref,
      reissue_of: input.reissue_of,
    }))
    const resolved = resolvePrintTrailTargetStep({ order: loaded.order, rows: loaded.rows, request })

    const scoped = transform({ loaded, resolved, input }, ({ loaded, resolved, input }) => ({
      lines: resolved.target.ok ? scopedLines(loaded.allLines, loaded.rows, resolved.target) : [],
      sequence: resolved.target.ok ? resolved.target.sequence : (input.sequence ?? 1),
      source_ref: resolved.target.ok ? resolved.target.sourceRef : null,
    }))

    // Lets a store hold lines back (e.g. unreleased pre-orders). The handler
    // returns { lines }; held lines are sent later by running this again.
    const filterLines = createHook("filterLines", {
      order: loaded.order,
      lines: scoped.lines,
      sequence: scoped.sequence,
      source_ref: scoped.source_ref,
    })
    const lines = transform(
      { scoped, hookResult: filterLines.getResult() },
      ({ scoped, hookResult }): SelectedLine[] =>
        (hookResult as { lines?: SelectedLine[] } | undefined)?.lines ?? scoped.lines
    )

    // Changes the order number of a new Print Trail order. The handler
    // returns { orderNumber }; an unusable value falls back to the default.
    const orderNumberHook = createHook("orderNumber", {
      order: loaded.order,
      sequence: scoped.sequence,
      source_ref: scoped.source_ref,
      orderNumber: resolved.defaultOrderNumber,
    })
    const prepared = preparePrintTrailPayloadStep({
      order: loaded.order,
      lines,
      resolved,
      hookOrderNumber: orderNumberHook.getResult(),
    })

    // A last chance to change the payload (address, purchaseOrder,
    // printTrailOrderNumber, orderUrl). The handler returns { payload }.
    const payloadHook = createHook("payload", {
      order: loaded.order,
      sequence: scoped.sequence,
      source_ref: scoped.source_ref,
      payload: transform({ prepared }, ({ prepared }) => (prepared.prepared?.ok ? prepared.prepared.payload : null)),
    })

    const create = createPrintTrailDraftStep({
      order: loaded.order,
      lines,
      selected: scoped.lines,
      target: resolved.target,
      orderNumber: prepared.orderNumber,
      prepared: prepared.prepared,
      payloadOverride: payloadHook.getResult(),
    })
    const gate = printTrailConfirmGateStep({ order: loaded.order, create })

    const confirmed = when("print-trail-gate-allows-confirm", { gate, create }, ({ gate, create }) =>
      !!(gate.ok && create.rowId && create.pt)
    ).then(() => {
      const confirmInput = transform({ gate, create }, ({ gate, create }) => ({
        rowId: create.rowId!,
        pt: create.pt!,
        body: gate.body!,
        methodByLine: create.methodByLine,
      }))
      return confirmPrintTrailOrderStep(confirmInput)
    })

    const events = recordPrintTrailSendOutcomeStep({
      orderId: input.order_id,
      create,
      gate,
      confirm: confirmed,
    })
    emitPrintTrailEventsStep(events)

    releaseLockStep({ key: lockKey })

    const result = transform(
      { create, gate, confirmed },
      ({ create, gate, confirmed }): {
        create: CreateOutcome
        gate: GateOutcome
        confirm: ConfirmOutcome | null
      } => ({ create, gate, confirm: confirmed ?? null })
    )
    return new WorkflowResponse(result, { hooks: [filterLines, orderNumberHook, payloadHook] })
  }
)

export type FilterLinesHookInput = {
  order: GraphOrder
  lines: SelectedLine[]
  sequence: number
  source_ref: string | null
}
export type OrderNumberHookInput = { order: GraphOrder; sequence: number; source_ref: string | null; orderNumber: string }
export type PayloadHookInput = { order: GraphOrder; sequence: number; source_ref: string | null; payload: PtCreateOrderRequest }
