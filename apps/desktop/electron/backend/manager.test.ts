import { describe, expect, it, vi } from 'vitest'
import { parentPidForPlatform } from './manager.ts'

describe('parentPidForPlatform', () => {
  it('uses a non-interactive CIM query on Windows instead of POSIX ps', () => {
    const query = vi.fn(() => '42\r\n')

    expect(parentPidForPlatform(123, 'win32', query)).toBe(42)
    expect(query).toHaveBeenCalledWith('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process -Filter 'ProcessId = 123' | Select-Object -ExpandProperty ParentProcessId"
    ])
  })

  it('does not issue a process query for an invalid PID', () => {
    const query = vi.fn(() => '42')

    expect(parentPidForPlatform(0, 'win32', query)).toBeNull()
    expect(query).not.toHaveBeenCalled()
  })

  it('returns null when the process is gone or the host command fails', () => {
    expect(parentPidForPlatform(123, 'win32', () => '')).toBeNull()
    expect(parentPidForPlatform(123, 'win32', () => { throw new Error('gone') })).toBeNull()
  })
})
