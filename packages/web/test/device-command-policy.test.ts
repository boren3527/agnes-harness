import { describe, expect, it } from 'vitest'
import { isDirectDeviceCommand } from '../src/device-command-policy.js'

describe('direct robot console commands', () => {
  it.each([
    'ext:agnes-examples/aka-robot',
    'web:@agnes-examples/aka-robot-plugin',
    '@agnes-examples/aka-robot-plugin',
  ])('allows explicit console actions from %s', (owner) => {
    expect(isDirectDeviceCommand(owner, { id: 'aka.control.stop', effectService: 'aka.control.stop' })).toBe(
      true,
    )
    expect(
      isDirectDeviceCommand(owner, {
        id: 'aka.recognition.round.read',
        effectService: 'aka.recognition.round.read',
      }),
    ).toBe(true)
  })
  it('keeps confirmation for unrelated plugins and undeclared effects', () => {
    expect(
      isDirectDeviceCommand('ext:other', { id: 'aka.control.stop', effectService: 'aka.control.stop' }),
    ).toBe(false)
    expect(
      isDirectDeviceCommand('ext:agnes-examples/aka-robot', {
        id: 'aka.control.stop',
        effectService: 'other.effect',
      }),
    ).toBe(false)
    expect(
      isDirectDeviceCommand('ext:agnes-examples/aka-robot', {
        id: 'aka.control.unknown',
        effectService: 'aka.control.unknown',
      }),
    ).toBe(false)
    expect(isDirectDeviceCommand('ext:agnes-examples/aka-robot', { id: 'aka.control.stop' })).toBe(false)
  })
})
