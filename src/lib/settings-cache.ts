import type { PrintTrailPluginOptions } from "../config"
import { applyOverrides, type SettingKey, type SettingRecord } from "./settings"

// How long a process keeps the effective options before reading the admin's
// settings again. A save clears the saving process's copy at once; another
// process (a worker) sees it within this time.
export const SETTINGS_CACHE_MS = 5_000

type Deps = {
  config: PrintTrailPluginOptions
  read(): Promise<Partial<Record<SettingKey, SettingRecord>>>
  warn?(message: string): void
  now?(): number
}

// The options in force: the plugin options with the settings saved in the
// admin over them, read again once SETTINGS_CACHE_MS old. A failed read
// keeps the last options read, of any age, rather than falling back to the
// plugin options, which could undo an admin's choice (confirmOn, say); with
// none read yet, it throws like any other database read.
export class EffectiveOptions {
  private cached: { options: PrintTrailPluginOptions; readAt: number } | null = null
  // Bumped by clear(): a read that started before a clear (and so may have
  // read the settings before a save) is returned to its caller but never
  // cached.
  private generation = 0
  // The last options read, kept through a clear for a failed read to fall
  // back on.
  private last: PrintTrailPluginOptions | null = null

  constructor(private readonly deps: Deps) {}

  async get(): Promise<PrintTrailPluginOptions> {
    const now = this.deps.now ? this.deps.now() : Date.now()
    if (this.cached && now - this.cached.readAt < SETTINGS_CACHE_MS) return this.cached.options
    try {
      return await this.read(now)
    } catch (e) {
      if (!this.last) throw e
      this.deps.warn?.(`Print Trail: couldn't read the settings; using those read earlier: ${(e as Error)?.message ?? e}`)
      return this.last
    }
  }

  // The options read now, past the cache, for a decision that mustn't act
  // on a setting changed in the last few seconds (the confirm gate). A
  // failed read throws: the options read earlier could be the very setting
  // just changed (confirming an unpaid order under a stale order.placed).
  async fresh(): Promise<PrintTrailPluginOptions> {
    this.clear()
    return this.read(this.deps.now ? this.deps.now() : Date.now())
  }

  // Reads the settings; the result is cached unless a clear() came while
  // the read ran.
  private async read(now: number): Promise<PrintTrailPluginOptions> {
    const generation = this.generation
    const records: Partial<Record<SettingKey, SettingRecord>> = await this.deps.read()
    const options = applyOverrides(this.deps.config, records, this.deps.warn)
    if (generation === this.generation) {
      this.cached = { options, readAt: now }
      this.last = options
    }
    return options
  }

  // The next get() reads the settings again, and a read already running
  // isn't cached.
  clear(): void {
    this.generation++
    this.cached = null
  }
}
