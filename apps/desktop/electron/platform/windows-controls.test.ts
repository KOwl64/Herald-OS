import { describe, expect, it, vi } from 'vitest'

const exec = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('./exec.ts', () => ({ MISSING_BINARY: 127, run: exec.run }))
const { HostNotSupported } = await import('./types.ts')
const { parseActivePowerScheme, parseWifiInterface, parseWifiProfiles, parseWindowsAudioStatus, parseWindowsHelperResponse, windowsControlAction, windowsControlStatus, windowsControlsExecutable, mapWindowsAudioDevice } = await import('./windows-controls.ts')
const stats = async () => ({ sampledAt: 1, cpuPercent: 0, loadAverage: [0, 0, 0] as [number, number, number], memoryTotal: 100, memoryUsed: 50, memoryFree: 50, uptimeSeconds: 1, disks: [], battery: { present: false } })
const success = (stdout = '') => ({ stdout, stderr: '', code: 0 })

describe('Windows quick controls', () => {
  it('uses only the bundled helper path and accepts exactly one JSON-lines response', () => {
    expect(windowsControlsExecutable('C:\\Program Files\\Herald OS\\resources', 'C:\\source', () => true)).toBe('C:\\Program Files\\Herald OS\\resources\\windows-controls\\Herald.WindowsControls.exe')
    expect(windowsControlsExecutable('C:\\missing', 'C:\\source', () => false)).toBe('C:\\source\\build\\windows-controls\\Herald.WindowsControls.exe')
    expect(parseWindowsHelperResponse('{"ok":true,"result":{"present":true,"percent":80}}\n')).toEqual({ ok: true, result: { present: true, percent: 80 } })
    expect(() => parseWindowsHelperResponse('{"ok":true}\n{"ok":true}\n')).toThrow('invalid response')
    expect(() => parseWindowsHelperResponse('not json\n')).toThrow('invalid JSON')
  })

  it('parses a radio, SSID and saved Wi-Fi profiles', () => {
    expect(parseWifiInterface('Name : Wi-Fi\nSSID : Studio\nBSSID : xx\nRadio status : Hardware On\n               Software On\n')).toEqual({ available: true, name: 'Wi-Fi', enabled: true, connected: 'Studio' })
    expect(parseWifiInterface('There is no wireless interface on the system.')).toEqual({ available: false, enabled: false })
    expect(parseWifiProfiles('All User Profile : Studio\nAll User Profile : Guest\n', 'Studio')).toEqual([
      { ssid: 'Studio', signal: 0, secure: true, known: true, active: true }, { ssid: 'Guest', signal: 0, secure: true, known: true, active: false }
    ])
  })

  it('maps Windows invariant power scheme GUIDs to portable profile names', () => {
    expect(parseActivePowerScheme('Power Scheme GUID: 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c (High performance)')).toBe('performance')
  })

  it('gets Wi-Fi and power state through fixed argv', async () => {
    exec.run.mockResolvedValueOnce(success('Name : Wi-Fi\nSSID : Home\nRadio status : Hardware On\n Software On\n')).mockResolvedValueOnce(success('All User Profile : Home\n'))
    await expect(windowsControlStatus('wifi', stats)).resolves.toMatchObject({ panel: 'wifi', wifi: { connected: 'Home', networks: [{ ssid: 'Home', known: true, active: true }] } })
    expect(exec.run.mock.calls[0]).toEqual(['netsh', ['wlan', 'show', 'interfaces'], 10_000])
    exec.run.mockResolvedValueOnce(success('Power Scheme GUID: a1841308-3541-4fab-bc81-f71556f20b4a (Power saver)'))
    await expect(windowsControlStatus('power', stats)).resolves.toMatchObject({ panel: 'power', power: { profile: 'power-saver', profiles: ['balanced', 'performance', 'power-saver'] } })
  })

  it('joins only saved profiles and never puts passwords on a command line', async () => {
    exec.run.mockResolvedValue(success('Name : Wi-Fi\nRadio status : Hardware On\n Software On\n'))
    await windowsControlAction({ panel: 'wifi', action: 'connect', ssid: 'Office Wi-Fi' })
    expect(exec.run).toHaveBeenLastCalledWith('netsh', ['wlan', 'connect', 'name=Office Wi-Fi', 'interface=Wi-Fi'], 15_000)
    await expect(windowsControlAction({ panel: 'wifi', action: 'connect', ssid: 'Office Wi-Fi', password: 'secret' })).rejects.toThrow('saved profiles')
    expect(exec.run).toHaveBeenCalledTimes(2)
  })

  it('sets power only through a static GUID allowlist', async () => {
    exec.run.mockResolvedValue(success())
    await windowsControlAction({ panel: 'power', action: 'profile', profile: 'balanced' })
    expect(exec.run).toHaveBeenLastCalledWith('powercfg', ['/setactive', '381b4222-f694-41f0-9685-ff5bb260df2e'], 15_000)
  })

  it('translates the native audio DTO and rejects malformed entries', () => {
    const good = { available: true, outputs: [{ id: 'render-1', name: 'Speakers', isDefault: true, volume: 41.4, muted: false }], inputs: [{ id: 'capture-1', name: 'Mic', isDefault: true, volume: 80, muted: true }] }
    expect(parseWindowsAudioStatus(good)).toEqual({
      available: true,
      outputs: [{ id: 'render-1', name: 'Speakers', isDefault: true, volume: 41, muted: false }],
      inputs: [{ id: 'capture-1', name: 'Mic', isDefault: true, volume: 80, muted: true }]
    })
    // Malformed shapes are dropped, not thrown — the helper may legitimately report a half-populated panel.
    expect(parseWindowsAudioStatus({ available: true, outputs: [{ id: 'render-1' }], inputs: [] })).toEqual({ available: true, outputs: [], inputs: [] })
    // The wrapper itself rejects non-objects and missing `available`, so a helper bug surfaces immediately.
    expect(() => parseWindowsAudioStatus(null)).toThrow('invalid audio status')
    expect(() => parseWindowsAudioStatus({ outputs: [], inputs: [] })).toThrow('invalid audio status')
    // Each device field is checked independently so a single bad record does not poison the panel.
    expect(mapWindowsAudioDevice({ id: 'x', name: 'X', isDefault: false, volume: -1, muted: false })).toBeNull()
    expect(mapWindowsAudioDevice({ id: 'x', name: 'X', isDefault: 'no', volume: 50, muted: false })).toBeNull()
  })

  it('refuses to change the Windows audio default device and names the only supported alternative', async () => {
    await expect(windowsControlAction({ panel: 'audio', action: 'default', kind: 'output', id: 'render-1' })).rejects.toBeInstanceOf(HostNotSupported)
  })
})
