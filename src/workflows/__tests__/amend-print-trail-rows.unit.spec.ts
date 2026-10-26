import { reattachSources, unservedAttentionDue } from "../steps/amend-print-trail-rows"

describe("unservedAttentionDue", () => {
  it("flags an edit that adds a Print Trail item without a Print Trail shipping method, once", () => {
    expect(unservedAttentionDue(["b", "a"], [])).toBe("a,b")
    expect(unservedAttentionDue(["a", "b"], ["a,b"])).toBeNull()
    expect(unservedAttentionDue(["a", "b", "c"], ["a,b"])).toBe("a,b,c")
    expect(unservedAttentionDue([], ["a,b"])).toBeNull()
  })
})

describe("reattachSources", () => {
  it("keeps claim and exchange sources on lines a filterLines handler rebuilt", () => {
    const all = [
      { lineItemId: "i1", sku: "A", quantity: 1, method: "standard", replacementOf: null },
      { lineItemId: "c1", sku: "B", quantity: 1, method: "standard", replacementOf: "claim:c1" },
    ]
    expect(reattachSources([{ lineItemId: "c1", sku: "B", quantity: 1, method: "standard" }], all)).toEqual([all[1]])
    expect(reattachSources(undefined, all)).toEqual(all)
  })
})
