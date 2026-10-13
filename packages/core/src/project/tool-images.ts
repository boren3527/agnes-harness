import type { ArtifactRef, ToolResult } from '@agnes/protocol'

/** Display hints only; the artifact reader still checks session/lane authority and byte identity. */
export function toolImages(result: ToolResult): Array<{ index: number; ref: ArtifactRef }> {
  if (result.isError || result.cancelledBy || result.interrupted) return []
  // Older render tools recorded size in their structured receipt before links retained it.
  const structured = result.structured as { artifact?: { ref?: ArtifactRef } } | undefined
  const legacy = structured?.artifact?.ref
  const seen = new Set<string>()
  return result.content.flatMap((block, index) => {
    if (block.type !== 'resource_link' || !['image/png', 'image/jpeg'].includes(block.mimeType ?? ''))
      return []
    const sha256 = /^artifact:\/\/([0-9a-f]{64})$/.exec(block.uri)?.[1]
    if (!sha256 || seen.has(sha256)) return []
    // Model observations (including reference examples) are not user-facing deliverables.
    // Explicit ref blocks use "artifact"; older renderers declare their output in the receipt.
    if (block.name !== 'artifact' && !(legacy?.sha256 === sha256 && legacy.mime === block.mimeType)) return []
    const size =
      block.size ?? (legacy?.sha256 === sha256 && legacy.mime === block.mimeType ? legacy.size : undefined)
    if (!Number.isSafeInteger(size) || (size ?? 0) <= 0 || (size ?? 0) > 8 * 1024 * 1024) return []
    seen.add(sha256)
    return [{ index, ref: { sha256, size: size as number, mime: block.mimeType as string } }]
  })
}
