import type { LocaleCatalog } from '@agnes/web-client'

export const deviceLocaleCatalog: LocaleCatalog = {
  en: {
    'device.workbench.title': 'Device',
    'device.workbench.refresh': 'Refresh device session',
    'device.workbench.detach': 'Unbind device',
    'device.workbench.detachDescription':
      'Unbind this workspace’s device? All its device sessions become inactive; conversation and photos remain. This does not stop the robot. Use the robot’s controls to stop any motion first.',
    'device.workbench.cancel': 'Cancel',
    'device.workbench.detaching': 'Updating device association…',
    'device.workbench.detachFailed':
      'Could not verify unbinding. The association has been refreshed; check its current state before retrying.',
    'device.workbench.lookupUnavailable':
      'Current device association is unavailable. Refresh to check again; device controls remain disabled.',
    'device.workbench.chatShare': 'Conversation width',
    'device.workbench.unavailable': 'The device control panel is not ready. Conversation remains available.',
    'device.workbench.inactive':
      'This session’s device binding is inactive. Historical conversation remains available.',
  },
  'zh-CN': {
    'device.workbench.title': '设备',
    'device.workbench.refresh': '刷新设备会话',
    'device.workbench.detach': '解绑设备',
    'device.workbench.detachDescription':
      '解绑此工作区的设备？所有关联设备会话都会失效，会话和照片保留。解绑不会使小车停车，请先通过小车控制台停止正在执行的动作。',
    'device.workbench.cancel': '取消',
    'device.workbench.detaching': '正在更新设备关联…',
    'device.workbench.detachFailed': '无法核实解绑结果，已重新查询关联；请核对当前状态后再决定是否重试。',
    'device.workbench.lookupUnavailable': '当前设备关联无法读取，请刷新重查；设备操作保持关闭。',
    'device.workbench.chatShare': '会话区域宽度',
    'device.workbench.unavailable': '设备控制台尚未就绪，可以继续使用会话。',
    'device.workbench.inactive': '此会话的设备关联已失效，仍可查看历史会话。',
  },
}
