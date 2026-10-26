// Values from orders and from Print Trail go into HTML, so every one is
// escaped, in text and in attributes alike.
export const escapeHtml = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

// Only absolute http(s) links are rendered as links; anything else
// (javascript:, mailto:, a relative or protocol-relative URL) as text.
export const isHttpUrl = (v: unknown): v is string => typeof v === "string" && /^https?:\/\/\S+$/i.test(v)

// An empty label shows the URL itself, so a link is never invisible.
export const link = (url: unknown, label: string): string =>
  isHttpUrl(url) ? `<a href="${escapeHtml(url)}">${escapeHtml(label || url)}</a>` : escapeHtml(label)

// The plain-text form: the label, then the URL when it is an http(s) one.
export const textLink = (url: unknown, label: string): string => (isHttpUrl(url) ? `${label} (${url})` : label)

export type EmailContent = { subject: string; html: string; text: string }

export const orderLabel = (order: { id?: string | null; display_id?: number | string | null } | undefined): string => {
  const displayId = order?.display_id
  return displayId !== null && displayId !== undefined && displayId !== "" ? `#${displayId}` : order?.id ?? ""
}

// Plain styling, which any mail client shows.
export const wrap = (body: string): string => `<div style="font-family:Arial,sans-serif;line-height:1.5">${body}</div>`
