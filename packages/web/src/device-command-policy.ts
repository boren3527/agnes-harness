/** Direct clicks in the installed robot console are user requests, not agent approvals.
 * Keep this exception scoped to the declared robot commands; backend checks still apply.
 */
export function isDirectDeviceCommand(
  owner: string,
  command: { id: string; effectService?: string | undefined },
): boolean {
  if (
    ![
      'ext:agnes-examples/aka-robot',
      'web:@agnes-examples/aka-robot-plugin',
      '@agnes-examples/aka-robot-plugin',
    ].includes(owner)
  )
    return false
  const services: Record<string, string> = {
    'aka.pair.probe': 'aka.probe',
    'aka.pair.connect': 'aka.connect',
    'aka.pair.disconnect': 'aka.disconnect',
    'aka.pair.camera': 'aka.camera.set',
    'aka.capture.photo': 'aka.capture',
    'aka.control.action': 'aka.control.action',
    'aka.control.stop': 'aka.control.stop',
    'aka.settings.read': 'aka.settings.read',
    'aka.settings.save': 'aka.settings.save',
    'aka.task.cancel': 'aka.task.cancel',
    'aka.geometry.save': 'aka.geometry.save',
    'aka.recognition.round.read': 'aka.recognition.round.read',
    'aka.recognition.round.start': 'aka.recognition.round.start',
    'aka.recognition.test': 'aka.recognition.test',
  }
  return Object.hasOwn(services, command.id) && services[command.id] === command.effectService
}
