import type { ControlAction, PowerState, StatusPanelId, StatusPanelState, SystemStats, WifiNetwork, WifiState } from '../../shared/ipc.ts'
import { MISSING_BINARY, run } from './exec.ts'
import { HostNotSupported } from './types.ts'

/* Windows uses its inbox commands. Every user value stays in one argv item; no shell or Wi-Fi
 * password is invoked. Herald can only join profiles Windows already saved. */
const POWER_SCHEMES = {
  balanced: '381b4222-f694-41f0-9685-ff5bb260df2e',
  performance: '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c',
  'power-saver': 'a1841308-3541-4fab-bc81-f71556f20b4a'
} as const
const SCHEME_BY_GUID = new Map(Object.entries(POWER_SCHEMES).map(([name, guid]) => [guid, name]))

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
  const active = await run('powercfg', ['/getactivescheme'], 8000)
  return { available: active.code === 0, battery: stats.battery, profile: active.code === 0 ? parseActivePowerScheme(active.stdout) : undefined, profiles: Object.keys(POWER_SCHEMES) }
}

export async function windowsControlStatus(panel: StatusPanelId, stats: () => Promise<SystemStats>): Promise<StatusPanelState> {
  if (panel === 'wifi') return { panel, wifi: await wifiState() }
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
  throw new HostNotSupported(`${action.panel} quick controls`)
}
