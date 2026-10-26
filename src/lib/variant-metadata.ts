// How Medusa saves an update to a variant's metadata depends on its version:
//
// - Up to 2.18 the product module replaces it whole (updateVariants_ uses
//   upsertWithReplace; mergeMetadata isn't applied). Sending only the
//   plugin's key would erase the rest, print_trail_sku included, and an
//   empty string is stored as a value; a key is removed by leaving it out.
// - From 2.19.0 (medusajs/medusa#16179) the update is merged into the stored
//   metadata with mergeMetadata: a key left out is kept, and an empty string
//   deletes it.
//
// The plugin reads the current metadata and writes it whole, with only its
// own keys changed, which is right for both. A patch value of "" deletes a
// key: left out of the write when Medusa replaces, written as "" when it
// merges.
export type MetadataUpdateMode = "replace" | "merge"

export function metadataUpdateModeFor(medusaVersion: string | null | undefined): MetadataUpdateMode {
  const match = /^(\d+)\.(\d+)\./.exec(medusaVersion ?? "")
  // Unknown: assume the current behaviour.
  if (!match) return "merge"
  const major = Number(match[1])
  const minor = Number(match[2])
  return major > 2 || (major === 2 && minor >= 19) ? "merge" : "replace"
}

let installedMode: MetadataUpdateMode | undefined

// The store's Medusa, read once. @medusajs/medusa pins the product module to
// its own version.
export function installedMetadataUpdateMode(): MetadataUpdateMode {
  if (!installedMode) {
    let version: string | null = null
    try {
      version = (require("@medusajs/medusa/package.json") as { version?: string }).version ?? null
    } catch {
      version = null
    }
    installedMode = metadataUpdateModeFor(version)
  }
  return installedMode
}

export function mergeVariantMetadata(
  current: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>,
  mode: MetadataUpdateMode = "replace"
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(current ?? {}) }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== "") merged[key] = value
    else if (mode === "merge" && Object.prototype.hasOwnProperty.call(merged, key)) merged[key] = ""
    else delete merged[key]
  }
  // The plugin writes SKUs as strings.
  if (typeof merged.print_trail_sku === "number") merged.print_trail_sku = String(merged.print_trail_sku)
  return merged
}

export type VariantMetadataPatch = {
  id: string
  metadata: Record<string, unknown>
  fields?: Record<string, unknown>
  // Write only when the variant's current metadata passes this.
  when?: (metadata: Record<string, unknown> | null) => boolean
}

export type VariantMetadataStore = {
  read(ids: string[]): Promise<{ id: string; metadata: Record<string, unknown> | null }[]>
  write(rows: ({ id: string; metadata: Record<string, unknown> } & Record<string, unknown>)[]): Promise<void>
  // How write saves the metadata; "replace" when absent.
  mode?: MetadataUpdateMode
}

// Read-merge-write: a merchant's edit landing between the read and the write
// is lost (the window is one query).
export async function patchVariantMetadata(store: VariantMetadataStore, patches: VariantMetadataPatch[]): Promise<void> {
  if (!patches.length) return
  const current = new Map((await store.read(patches.map((p) => p.id))).map((v) => [v.id, v.metadata]))
  const rows = patches.flatMap((p) =>
    current.has(p.id) && (!p.when || p.when(current.get(p.id) ?? null))
      ? [{ id: p.id, ...(p.fields ?? {}), metadata: mergeVariantMetadata(current.get(p.id), p.metadata, store.mode) }]
      : []
  )
  if (rows.length) await store.write(rows)
}
