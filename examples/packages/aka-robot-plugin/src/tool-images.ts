import type { ToolResult } from '@agnes/extension-api'

/** Core admits one artifact identity per tool result; observation records remain separate. */
export function uniqueImageContent(content: ToolResult['content']): ToolResult['content'] {
  const seen = new Set<string>()
  return content.filter((block) => {
    if (block.type !== 'image') return true
    if (seen.has(block.ref.sha256)) return false
    seen.add(block.ref.sha256)
    return true
  })
}
