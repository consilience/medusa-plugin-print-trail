// Which Locking Module provider the plugin's locks use (the default one).
// Supported: Redis (required for more than one process) or the in-memory
// default (a single process only). The Postgres provider is unsupported in
// 2.17.2: acquire never reclaims an expired lock with no owner, and its
// insert race lets two holders through.

export const LOCKING_CHECK_STATE_KEY = "locking_check"

export type LockingCheck = {
  provider: "in-memory" | "redis" | "postgres" | "other"
  postgresConfigured: boolean
  supported: boolean
}

type ProviderConfig = { resolve?: unknown; id?: unknown; is_default?: unknown }

const kindOf = (resolve: unknown): LockingCheck["provider"] => {
  const r = typeof resolve === "string" ? resolve : ""
  if (/locking-postgres/.test(r)) return "postgres"
  if (/locking-redis/.test(r)) return "redis"
  return "other"
}

export function detectLocking(configModule: unknown): LockingCheck {
  const modules = (configModule as { modules?: Record<string, unknown> } | undefined)?.modules ?? {}
  const locking = (modules as Record<string, { options?: { providers?: ProviderConfig[] } } | boolean | undefined>).locking
  const providers = (typeof locking === "object" && locking?.options?.providers) || []
  const postgresConfigured = providers.some((p) => kindOf(p?.resolve) === "postgres")
  // As the locking module's loader: the is_default provider, or the only one;
  // otherwise its built-in in-memory provider.
  const chosen = providers.find((p) => p?.is_default === true) ?? (providers.length === 1 ? providers[0] : undefined)
  const provider = chosen ? kindOf(chosen.resolve) : "in-memory"
  return { provider, postgresConfigured, supported: provider !== "postgres" }
}

export function lockingMessage(check: LockingCheck): { level: "error" | "warn" | "info"; text: string } {
  if (check.provider === "postgres") {
    return {
      level: "error",
      text:
        "Print Trail: the Postgres locking provider is the default, and it is unsupported: it never reclaims an expired lock and can let two holders through. Use @medusajs/medusa/locking-redis (required for more than one process), or the in-memory default for a single process.",
    }
  }
  if (check.postgresConfigured) {
    return {
      level: "warn",
      text: `Print Trail: a Postgres locking provider is configured but not the default (the plugin locks with ${check.provider}). Don't make it the default.`,
    }
  }
  return {
    level: "info",
    text: `Print Trail: locking with the ${check.provider} provider${check.provider === "in-memory" ? " (a single process only; use Redis locking for more)" : ""}.`,
  }
}
