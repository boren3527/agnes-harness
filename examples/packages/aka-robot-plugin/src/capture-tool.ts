import type { ToolContext, ToolResult } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { type CaptureDependencies, withCaptureFrame } from './capture-frame.js'
import { AkaProtocolError } from './protocol.js'

/** Saves an already admitted live frame. Never opens the camera or requests a robot snapshot. */
export function registerCaptureTool(deps: CaptureDependencies): void {
  deps.api.registerTool({
    name: 'aka_capture',
    description:
      '保存当前会话摄像头最新原图。动作后自动等待停车约一秒并丢弃期间的帧，只保存之后收到的新帧；若图仍模糊应再拍一张比较，不能拿模糊或历史照片判断当前目标。观察动作前后场景是否变化、目标是否仍在原位置。不连接或开启相机，不移动，不调用云识别。照片不单独证明抓取成功。',
    parameters: Type.Object({}, { additionalProperties: false }),
    meta: {
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      isOpenWorld: false,
      replay: 'never',
      costHint: undefined,
      deferLoading: false,
      requiresApproval: 'never',
      returnsImages: true,
    },
    async execute(input, ctx) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Reflect.ownKeys(input).length)
        throw new AkaProtocolError('Current camera capture unavailable')
      return capturePhoto(deps, ctx)
    },
  })
}

export async function capturePhoto(
  deps: CaptureDependencies,
  ctx: ToolContext,
  expected?: { bindingRevision: number; configRevision: number; afterReceivedAt?: number },
): Promise<ToolResult> {
  return withCaptureFrame(
    deps,
    ctx,
    async ({ bytes, selection, verify }) => {
      const ref = await ctx.artifacts.put(bytes, {
        mime: 'image/jpeg',
        name: `aka-${selection.artifact.sha256.slice(0, 16)}.jpg`,
      })
      await verify()
      const artifact = selection.artifact
      if (!ref || ref.sha256 !== artifact.sha256 || ref.size !== artifact.size || ref.mime !== artifact.mime)
        throw new AkaProtocolError('Current camera capture unavailable')
      const { artifact: _artifact, ...selected } = selection
      const facts = { ...selected, hash: artifact.sha256, size: artifact.size }
      return {
        content: [
          { type: 'text', text: JSON.stringify(facts) },
          { type: 'image', ref: { ...artifact }, mime: 'image/jpeg' },
        ],
        structured: facts,
      }
    },
    expected,
  )
}
