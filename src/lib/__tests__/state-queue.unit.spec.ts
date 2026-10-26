import { createEachUnlessExists } from "../state-queue"

describe("createEachUnlessExists", () => {
  it("ignores a key another writer created, and rethrows any other failure", async () => {
    const stored = new Set(["k2"])
    const created: string[] = []
    const create = async (key: string) => {
      if (stored.has(key)) throw new Error("already exists")
      if (key === "k3") throw new Error("connection reset")
      created.push(key)
    }
    const exists = async (key: string) => stored.has(key)
    await createEachUnlessExists(["k1", "k2"], create, exists)
    expect(created).toEqual(["k1"])
    await expect(createEachUnlessExists(["k3", "k4"], create, exists)).rejects.toThrow("connection reset")
  })
})
