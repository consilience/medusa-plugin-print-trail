import { confirmationSteps } from "../webhook-confirm"

describe("webhook confirmation steps", () => {
  it("asks about another address first, then an unsafe one", () => {
    expect(confirmationSteps({ action: "needs-confirmation", state: "elsewhere", warnings: [] })).toEqual(["elsewhere"])
    expect(confirmationSteps({ action: "needs-confirmation", state: "not-registered", warnings: ["not-https"] })).toEqual(["unsafe"])
    expect(confirmationSteps({ action: "needs-confirmation", state: "elsewhere", warnings: ["local-address"] })).toEqual(["elsewhere", "unsafe"])
    expect(confirmationSteps({ action: "registered", state: "registered", warnings: [] })).toEqual([])
  })
})
