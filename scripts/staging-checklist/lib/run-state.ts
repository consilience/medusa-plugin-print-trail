// What a run has placed, written to disk as it happens, so a run that dies
// (or a later `--cleanup <run id>`) can still cancel everything.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Mode } from "./config"
import { ChecklistError } from "./runner"

export type StateFile = {
  runId: string
  mode: Mode
  store: string
  printTrail: string
  startedAt: string
  orders: Record<string, { displayId: number | null; ptUuids: string[] }>
}

export const statePath = (dir: string, runId: string) => join(dir, `${runId}.state.json`)

export class RunState {
  private constructor(
    readonly file: string,
    readonly data: StateFile
  ) {}

  static create(dir: string, init: Omit<StateFile, "orders">): RunState {
    mkdirSync(dir, { recursive: true })
    const file = statePath(dir, init.runId)
    const existing = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as StateFile) : null
    const state = new RunState(file, { ...init, orders: existing?.orders ?? {} })
    state.save()
    return state
  }

  static load(dir: string, runId: string): RunState {
    const file = statePath(dir, runId)
    if (!existsSync(file)) throw new ChecklistError(`no state file for run ${runId} (${file})`)
    return new RunState(file, JSON.parse(readFileSync(file, "utf8")))
  }

  get orderIds(): string[] {
    return Object.keys(this.data.orders)
  }

  addOrder(orderId: string, displayId: number | null) {
    const o = this.data.orders[orderId]
    if (o) {
      if (displayId !== null) o.displayId = displayId
    } else {
      this.data.orders[orderId] = { displayId, ptUuids: [] }
    }
    this.save()
  }

  addPtUuid(orderId: string, uuid: string | null | undefined) {
    if (!uuid) return
    this.addOrder(orderId, this.data.orders[orderId]?.displayId ?? null)
    const o = this.data.orders[orderId]
    if (!o.ptUuids.includes(uuid)) {
      o.ptUuids.push(uuid)
      this.save()
    }
  }

  private save() {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    renameSync(tmp, this.file)
  }
}
