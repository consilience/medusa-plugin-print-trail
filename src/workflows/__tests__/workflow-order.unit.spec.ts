import { WorkflowManager } from "@medusajs/framework/orchestration"
import { amendPrintTrailOrderWorkflowId } from "../amend-print-trail-order"

// The registered workflow's steps in the order they run.
function stepOrder(id: string): string[] {
  const out: string[] = []
  let node = (WorkflowManager.getWorkflow(id) as { flow_: any }).flow_
  while (node) {
    if (node.action) out.push(node.action)
    node = Array.isArray(node.next) ? node.next[0] : node.next
  }
  return out
}

describe("amendPrintTrailOrderWorkflow", () => {
  it("counts the amend lease right after the lock, before anything that can throw", () => {
    const steps = stepOrder(amendPrintTrailOrderWorkflowId)
    const at = (s: string) => steps.indexOf(s)
    expect(at("lease-amend-rows")).toBe(at("acquire-lock-step") + 1)
    expect(at("record-amend-intent")).toBeLessThan(at("acquire-lock-step"))
    expect(at("lease-amend-rows")).toBeLessThan(at("load-order-for-print-trail"))
    expect(at("lease-amend-rows")).toBeLessThan(at("filterLines"))
  })
})
