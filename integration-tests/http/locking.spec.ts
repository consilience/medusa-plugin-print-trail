import path from "node:path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { useMock } from "./harness"
import { runJob } from "./helpers/jobs"
import { CONFIRMS, POSTS, requests, rowFor } from "./helpers/rows"
import { seedStore, type Seed } from "./helpers/seed"
import { backdateOrder, createOrderDirect } from "./helpers/store"
import { waitFor } from "./helpers/wait"

// With REDIS_URL set the fixture uses locking-redis (CI sets it). Without it,
// Medusa's in-memory lock is per process, so this test means nothing: skip.
const suite = process.env.REDIS_URL ? describe : describe.skip

jest.setTimeout(180_000)

suite("Redis locking", () => {
  const mock = useMock()

  medusaIntegrationTestRunner({
    cwd: path.join(__dirname, "app"),
    testSuite: ({ getContainer, dbConnection, utils }) => {
      let seed: Seed

      beforeAll(async () => {
        seed = await seedStore(getContainer())
      })

      it("two concurrent sends of one order make one Print Trail order", async () => {
        const container = getContainer()
        const { orderId } = await createOrderDirect(container, seed, [{ variantId: seed.variants.pt, quantity: 1 }])
        await backdateOrder(dbConnection, orderId, 10)
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { sendOrderToPrintTrailWorkflow } = require(path.resolve(__dirname, "../../.medusa/server/src/workflows"))

        await Promise.all([
          runJob(container, "print-trail-sweep"),
          runJob(container, "print-trail-sweep"),
          sendOrderToPrintTrailWorkflow(container).run({ input: { order_id: orderId } }),
        ])
        await utils.waitWorkflowExecutions()

        await waitFor(async () => (await rowFor(container, orderId))?.confirmed_at, { what: "the confirmed row" })
        expect(requests(mock(), "POST", POSTS)).toHaveLength(1)
        expect(requests(mock(), "PUT", CONFIRMS)).toHaveLength(1)
      })
    },
  })
})
