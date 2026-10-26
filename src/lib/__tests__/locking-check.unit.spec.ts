import { detectLocking } from "../locking-check"

const withLocking = (providers: unknown[]) => ({
  modules: { locking: { resolve: "@medusajs/medusa/locking", options: { providers } } },
})

describe("detectLocking", () => {
  it("reads the in-memory default when no locking module is configured", () => {
    expect(detectLocking({ modules: {} })).toEqual({ provider: "in-memory", postgresConfigured: false, supported: true })
    expect(detectLocking(undefined)).toEqual({ provider: "in-memory", postgresConfigured: false, supported: true })
  })

  it("flags the Postgres provider as the default, single or explicit", () => {
    const single = withLocking([{ resolve: "@medusajs/medusa/locking-postgres", id: "locking-postgres" }])
    expect(detectLocking(single)).toEqual({ provider: "postgres", postgresConfigured: true, supported: false })
    const explicit = withLocking([
      { resolve: "@medusajs/medusa/locking-redis", id: "locking-redis" },
      { resolve: "@medusajs/locking-postgres", id: "pg", is_default: true },
    ])
    expect(detectLocking(explicit)).toMatchObject({ provider: "postgres", supported: false })
  })

  it("accepts Redis, and flags a configured but non-default Postgres provider", () => {
    const redis = withLocking([
      { resolve: "@medusajs/medusa/locking-redis", id: "locking-redis", is_default: true },
      { resolve: "@medusajs/medusa/locking-postgres", id: "locking-postgres" },
    ])
    expect(detectLocking(redis)).toEqual({ provider: "redis", postgresConfigured: true, supported: true })
    // Several providers, none marked default: Medusa keeps the in-memory one.
    const none = withLocking([
      { resolve: "@medusajs/medusa/locking-redis", id: "a" },
      { resolve: "@medusajs/medusa/locking-postgres", id: "b" },
    ])
    expect(detectLocking(none)).toMatchObject({ provider: "in-memory", postgresConfigured: true })
  })
})
