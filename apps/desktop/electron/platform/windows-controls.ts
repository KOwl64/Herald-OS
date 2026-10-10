import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { AudioDevice, AudioState, BluetoothState, ControlAction, DisplayInfo, DisplayState, PowerState, StatusPanelId, StatusPanelState, SystemStats, WifiNetwork, WifiState } from '../../shared/ipc.ts'
import { MISSING_BINARY, run } from './exec.ts'
import { HostNotSupported } from './types.ts'

/* Windows uses its inbox commands. Every user value stays in one argv item; no shell or Wi-Fi
 * password is invoked. Herald can only join profiles Windows already saved. */
const POWER_SCHEMES = {
  balanced: '381b4222-f694-41f0-9685-ff5bb260df2e',
  performance: '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c',
  'power-saver': 'a1841308-3541-4fab-bc81-f71556f20b4a'
} as const
const SCHEME_BY_GUID: Map<string, string> = new Map(Object.entries(POWER_SCHEMES).map(([name, guid]) => [guid, name]))
const WINDOWS_CONTROLS_EXE = 'Herald.WindowsControls.exe'

type WindowsHelperResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: { code?: unknown; message?: unknown } }

/**
 * The native helper is an app resource in production and a fixed desktop build output while
 * developing.  There is deliberately no PATH lookup or environment override: this boundary
 * receives host-control requests and must never accidentally execute an unrelated executable.
 *
 * The helper is built per Windows architecture (win-x64 and win-arm64) and lives under a
 * matching subdirectory so a single installer can ship the binary for whichever architecture
 * the user is running.  ``arch`` defaults to the current process's arch; tests can pass
 * ``'x64'`` or ``'arm64'`` to lock the path.
 */
export function windowsControlsExecutable(resources = process.resourcesPath, cwd = process.cwd(), exists: (file: string) => boolean = existsSync, arch: NodeJS.Architecture = process.arch): string {
  const archDir = `windows-controls-${arch}`
  const packaged = resources ? path.join(resources, archDir, WINDOWS_CONTROLS_EXE) : undefined
  if (packaged && exists(packaged)) return packaged
  return path.resolve(cwd, 'build', archDir, WINDOWS_CONTROLS_EXE)
}

/** Parse exactly one response from the helper's JSON-lines protocol. */
export function parseWindowsHelperResponse(stdout: string): WindowsHelperResponse {
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (lines.length !== 1) throw new Error('Windows controls helper returned an invalid response')
  let parsed: unknown
  try {
    parsed = JSON.parse(lines[0])
  } catch {
    throw new Error('Windows controls helper returned invalid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as { ok?: unknown }).ok !== 'boolean') {
    throw new Error('Windows controls helper returned an invalid response')
  }
  return parsed as WindowsHelperResponse
}

type WindowsHelperVerb =
  | 'battery.status'
  | 'bluetooth.status'
  | 'display.status'
  | 'audio.status'
  | 'audio.volume'

interface WindowsHelperRequest {
  verb: WindowsHelperVerb
  id?: string
  percent?: number
  muted?: boolean
}

async function callWindowsHelper(request: WindowsHelperRequest, executable = windowsControlsExecutable()): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timeout: NodeJS.Timeout | undefined
    const finish = (error?: Error, result?: unknown): void => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (error) reject(error)
      else resolve(result)
    }
    timeout = setTimeout(() => {
      child.kill()
      finish(new Error('Windows controls helper timed out'))
    }, 5000)
    child.once('error', () => finish(new HostNotSupported('native Windows controls', 'the bundled Herald Windows controls helper')))
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('close', code => {
      if (code !== 0) {
        finish(new Error(stderr.trim() || 'Windows controls helper failed'))
        return
      }
      try {
        const response = parseWindowsHelperResponse(stdout)
        if (!response.ok) {
          const message = typeof response.error?.message === 'string' ? response.error.message : 'Windows controls helper rejected the request'
          finish(new Error(message))
          return
        }
        finish(undefined, response.result)
      } catch (error) {
        finish(error instanceof Error ? error : new Error('Windows controls helper failed'))
      }
    })
    child.stdin.end(`${JSON.stringify(request)}\n`)
  })
}

/** Read the Win32-backed battery state without introducing PowerShell into the control path. */
export async function windowsBatteryStatus(): Promise<SystemStats['battery']> {
  const result = await callWindowsHelper({ verb: 'battery.status' })
  if (!result || typeof result !== 'object') throw new Error('Windows controls helper returned an invalid battery status')
  const battery = result as { present?: unknown; percent?: unknown; charging?: unknown }
  if (typeof battery.present !== 'boolean') throw new Error('Windows controls helper returned an invalid battery status')
  const percent = typeof battery.percent === 'number' && Number.isInteger(battery.percent) && battery.percent >= 0 && battery.percent <= 100 ? battery.percent : undefined
  return { present: battery.present, ...(percent === undefined ? {} : { percent }), ...(typeof battery.charging === 'boolean' ? { charging: battery.charging } : {}) }
}

/** Translate the deliberately small native Bluetooth DTO into the shared panel shape. */
export async function windowsBluetoothStatus(): Promise<BluetoothState> {
  const result = await callWindowsHelper({ verb: 'bluetooth.status' })
  if (!result || typeof result !== 'object') throw new Error('Windows controls helper returned an invalid Bluetooth status')
  const bluetooth = result as { available?: unknown; radios?: unknown }
  if (typeof bluetooth.available !== 'boolean' || !Array.isArray(bluetooth.radios)) throw new Error('Windows controls helper returned an invalid Bluetooth status')
  const devices = bluetooth.radios.flatMap(radio => {
    if (!radio || typeof radio !== 'object') return []
    const { name, address } = radio as { name?: unknown; address?: unknown }
    return typeof name === 'string' && typeof address === 'string' ? [{ name, address, paired: false, connected: false }] : []
  })
  return { available: bluetooth.available, powered: bluetooth.available, devices }
}

/** Windows owns display configuration; Herald reports active monitors without taking it over. */
export async function windowsDisplayStatus(): Promise<DisplayState> {
  const result = await callWindowsHelper({ verb: 'display.status' })
  if (!result || typeof result !== 'object') throw new Error('Windows controls helper returned an invalid display status')
  const displays = (result as { monitors?: unknown }).monitors
  if (!Array.isArray(displays)) throw new Error('Windows controls helper returned an invalid display status')
  const mapped: DisplayInfo[] = displays.flatMap(monitor => {
    if (!monitor || typeof monitor !== 'object') return []
    const { deviceName, width, height } = monitor as { deviceName?: unknown; width?: unknown; height?: unknown }
    if (typeof deviceName !== 'string' || typeof width !== 'number' || !Number.isInteger(width) || typeof height !== 'number' || !Number.isInteger(height) || width <= 0 || height <= 0) return []
    return [{ name: deviceName, label: deviceName, enabled: true, width, height, refresh: 0, scale: 1, modes: [] }]
  })
  return { available: mapped.length > 0, displays: mapped }
}

/** Translate a single endpoint from the native helper's DTO into the shared shape. */
export function mapWindowsAudioDevice(device: unknown): AudioDevice | null {
  if (!device || typeof device !== 'object') return null
  const { id, name, isDefault, volume, muted } = device as { id?: unknown; name?: unknown; isDefault?: unknown; volume?: unknown; muted?: unknown }
  if (typeof id !== 'string' || typeof name !== 'string') return null
  if (typeof isDefault !== 'boolean') return null
  if (typeof volume !== 'number' || volume < 0 || volume > 100) return null
  if (typeof muted !== 'boolean') return null
  return { id, name, isDefault, volume: Math.round(volume), muted }
}

/** Parse the native audio.status DTO into the shared AudioState. */
export function parseWindowsAudioStatus(result: unknown): AudioState {
  if (!result || typeof result !== 'object') throw new Error('Windows controls helper returned an invalid audio status')
  const audio = result as { available?: unknown; outputs?: unknown; inputs?: unknown }
  if (typeof audio.available !== 'boolean') throw new Error('Windows controls helper returned an invalid audio status')
  const outputs = Array.isArray(audio.outputs) ? audio.outputs.map(mapWindowsAudioDevice).filter((device): device is AudioDevice => device !== null) : []
  const inputs = Array.isArray(audio.inputs) ? audio.inputs.map(mapWindowsAudioDevice).filter((device): device is AudioDevice => device !== null) : []
  return { available: audio.available, outputs, inputs }
}

/** Audio panel: read the documented MMDevice/Core Audio endpoints into the shared shape. */
export async function windowsAudioStatus(): Promise<AudioState> {
  return parseWindowsAudioStatus(await callWindowsHelper({ verb: 'audio.status' }))
}

/** Change the master volume or mute of an endpoint via the documented Core Audio scalar interface. */
export async function windowsAudioVolume(id: string | undefined, percent: number | undefined, muted: boolean | undefined): Promise<void> {
  if (percent === undefined && muted === undefined) throw new Error('audio.volume needs percent and/or muted')
  if (percent !== undefined && (!Number.isInteger(percent) || percent < 0 || percent > 100)) throw new Error('audio volume must be between 0 and 100')
  await callWindowsHelper({ verb: 'audio.volume', id, percent, muted })
}

export function parseWifiInterface(stdout: string): { available: boolean; name?: string; enabled: boolean; connected?: string } {
  if (/no wireless interface/i.test(stdout)) return { available: false, enabled: false }
  const name = /^\s*Name\s*:\s*(.+)$/mi.exec(stdout)?.[1]?.trim()
  const ssid = /^\s*SSID\s*:\s*(?!BSSID\b)(.+)$/mi.exec(stdout)?.[1]?.trim()
  const hardware = /Radio status\s*:\s*Hardware\s+(On|Off)/i.exec(stdout)?.[1]
  const software = /^\s*Software\s+(On|Off)\s*$/mi.exec(stdout)?.[1]
  return { available: Boolean(name), name, enabled: hardware !== 'Off' && software !== 'Off', connected: ssid || undefined }
}

/** `netsh wlan show profiles`, retaining only profiles that Windows can join without a secret. */
export function parseWifiProfiles(stdout: string, connected?: string): WifiNetwork[] {
  const names = new Set<string>()
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(?:All User Profile|Current User Profile)\s*:\s*(.+)$/i.exec(line)
    if (match?.[1].trim()) names.add(match[1].trim())
  }
  return [...names].map(ssid => ({ ssid, signal: 0, secure: true, known: true, active: ssid === connected }))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.ssid.localeCompare(b.ssid))
}

export function parseActivePowerScheme(stdout: string): string | undefined {
  const guid = /\b([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b/i.exec(stdout)?.[1]?.toLowerCase()
  return guid ? SCHEME_BY_GUID.get(guid) : undefined
}

async function required(command: string, args: string[], needs: string, timeoutMs = 15_000): Promise<string> {
  const result = await run(command, args, timeoutMs)
  if (result.code === MISSING_BINARY) throw new HostNotSupported(command, needs)
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} failed`)
  return result.stdout
}

async function wifiState(): Promise<WifiState> {
  const interfaces = await run('netsh', ['wlan', 'show', 'interfaces'], 10_000)
  if (interfaces.code !== 0) return { available: false, enabled: false, networks: [] }
  const adapter = parseWifiInterface(interfaces.stdout)
  if (!adapter.available) return { available: false, enabled: false, networks: [] }
  const profiles = await run('netsh', ['wlan', 'show', 'profiles'], 10_000)
  return { available: true, enabled: adapter.enabled, connected: adapter.connected, networks: profiles.code === 0 ? parseWifiProfiles(profiles.stdout, adapter.connected) : [] }
}

async function powerState(stats: SystemStats): Promise<PowerState> {
  const [active, battery] = await Promise.all([
    run('powercfg', ['/getactivescheme'], 8000),
    // The power profile remains useful during a partial install or an old development checkout.
    // In a packaged app this resolves through the bundled helper.
    windowsBatteryStatus().catch(() => stats.battery)
  ])
  return { available: active.code === 0, battery, profile: active.code === 0 ? parseActivePowerScheme(active.stdout) : undefined, profiles: Object.keys(POWER_SCHEMES) }
}

export async function windowsControlStatus(panel: StatusPanelId, stats: () => Promise<SystemStats>): Promise<StatusPanelState> {
  if (panel === 'wifi') return { panel, wifi: await wifiState() }
  if (panel === 'bluetooth') return { panel, bluetooth: await windowsBluetoothStatus() }
  if (panel === 'audio') return { panel, audio: await windowsAudioStatus() }
  if (panel === 'display') return { panel, display: await windowsDisplayStatus() }
  if (panel === 'power') return { panel, power: await powerState(await stats()) }
  throw new HostNotSupported(`${panel} quick controls`)
}

export async function windowsControlAction(action: ControlAction): Promise<void> {
  if (action.panel === 'wifi') {
    if (action.action === 'connect' && action.password) throw new HostNotSupported('joining a new Wi-Fi network', 'Windows Settings (Herald only joins saved profiles)')
    if (action.action === 'scan') { await required('netsh', ['wlan', 'show', 'networks'], 'Windows WLAN service'); return }
    const adapter = parseWifiInterface(await required('netsh', ['wlan', 'show', 'interfaces'], 'Windows WLAN service'))
    if (!adapter.name) throw new HostNotSupported('Wi-Fi', 'a Windows Wi-Fi adapter')
    if (action.action === 'enable') { await required('netsh', ['interface', 'set', 'interface', `name=${adapter.name}`, `admin=${action.enabled ? 'enabled' : 'disabled'}`], 'Windows network configuration permission'); return }
    if (action.action === 'disconnect') { await required('netsh', ['wlan', 'disconnect', `interface=${adapter.name}`], 'Windows WLAN service'); return }
    if (action.action === 'connect') { await required('netsh', ['wlan', 'connect', `name=${action.ssid}`, `interface=${adapter.name}`], 'Windows WLAN service'); return }
    await required('netsh', ['wlan', 'delete', 'profile', `name=${action.ssid}`, `interface=${adapter.name}`], 'Windows WLAN service')
    return
  }
  if (action.panel === 'power') {
    const scheme = POWER_SCHEMES[action.profile as keyof typeof POWER_SCHEMES]
    if (!scheme) throw new Error('unknown Windows power profile')
    await required('powercfg', ['/setactive', scheme], 'Windows power configuration permission')
    return
  }
  if (action.panel === 'audio') {
    // Windows exposes no supported public API to choose the default endpoint; surface that as a
    // HostNotSupported rather than reach for a private IPolicyConfig contract.
    if (action.action === 'default') throw new HostNotSupported('changing the Windows audio default device', 'Windows Sound settings (Windows has no documented API for choosing the default)')
    if (action.action === 'volume') { await windowsAudioVolume(action.id, action.percent, action.muted); return }
  }
  throw new HostNotSupported(`${action.panel} quick controls`)
}
