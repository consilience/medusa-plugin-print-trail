import { Text } from "@medusajs/ui"

// A Print Trail order number, linked into the Print Trail app when the
// server could build the link (a uuid and a stored team code), otherwise
// plain text.
export const PrintTrailLink = ({
  number,
  url,
  weight = "plus",
}: {
  number: string
  url: string | null
  weight?: "regular" | "plus"
}) => {
  if (!url) {
    return (
      <Text size="small" leading="compact" weight={weight}>
        {number}
      </Text>
    )
  }
  return (
    <Text size="small" leading="compact" weight={weight}>
      <a href={url} target="_blank" rel="noreferrer" className="text-ui-fg-interactive hover:text-ui-fg-interactive-hover">
        {number}
      </a>
    </Text>
  )
}
