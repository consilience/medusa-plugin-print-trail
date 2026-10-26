import type { ConnectionTestResult } from "../../lib/admin-types"

// The prompts a "needs-confirmation" registration asks, in order: taking over
// another address (never done without asking), then an address Print Trail
// can't deliver to. Yes to every one re-runs with force.
export function confirmationSteps(result: ConnectionTestResult["webhook"]): ("elsewhere" | "unsafe")[] {
  if (result.action !== "needs-confirmation") return []
  const steps: ("elsewhere" | "unsafe")[] = []
  if (result.state === "elsewhere") steps.push("elsewhere")
  if (result.warnings.length) steps.push("unsafe")
  return steps
}
