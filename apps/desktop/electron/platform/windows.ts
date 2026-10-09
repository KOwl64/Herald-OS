import { shell } from 'electron'
import os from 'node:os'
import type { CalendarResult, InstalledApp, NetworkStatus, ProcessInfo, RecentFile, StatusPanelState, SystemInfo, SystemStats } from '../../shared/ipc.ts'
import { type EditorTarget, type HostPlatform, HostNotSupported } from './types.ts'

/**
 * Windows host. Milestone 1 fills in what the shell needs to start and to be ready for the
 * Windows-side `HostAdapter` plugin to land: honest system info, an online placeholder for
 * network, and `unavailable` for calendar. Anything that needs PowerShell / `wmic` / `tasklist`
 * / shell out stays on the generic "not yet" path until Milestone 2 wires the plugin's
 * `HostAdapter`. The renderer never sees a shell here — every capability is an explicit method.
 */
export class WindowsPlatform implements HostPlatform {
  async systemInfo(): Promise<SystemInfo> {
    const cpus = os.cpus()

    return {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      osName: 'Windows',
      osVersion: os.release(),
      cpuModel: cpus[0]?.model ?? 'unknown',
      cpuCount: cpus.length,
      totalMemory: os.totalmem(),
      userName: os.userInfo().username,
      homeDir: os.homedir()
    }
  }

  async sampleStats(): Promise<SystemStats> {
    const total = os.totalmem()
    const free = os.freemem()

    return {
      sampledAt: Date.now(),
      cpuPercent: 0,
      // `os.loadavg()` returns [0, 0, 0] on Windows; surface the same shape so the renderer does
      // not have to branch on platform either.
      loadAverage: [0, 0, 0],
      memoryTotal: total,
      memoryUsed: total - free,
      memoryFree: free,
      uptimeSeconds: os.uptime(),
      disks: [],
      battery: { present: false }
    }
  }

  async listProcesses(): Promise<ProcessInfo[]> {
    return []
  }

  async listInstalledApps(): Promise<InstalledApp[]> {
    return []
  }

  async appIcon(): Promise<Buffer | null> {
    return null
  }

  async launchApp(appPath: string): Promise<void> {
    // The shell `openPath` is the cross-platform ask; it returns a non-empty string on failure
    // (e.g. an unknown URI handler) so we surface that as an Error.
    const error = await shell.openPath(appPath)

    if (error) {
      throw new Error(error)
    }
  }

  async revealPath(targetPath: string): Promise<void> {
    shell.showItemInFolder(targetPath)
  }

  async openIn(target: EditorTarget): Promise<void> {
    throw new HostNotSupported(`openIn(${target})`)
  }

  async networkStatus(): Promise<NetworkStatus> {
    // `os.networkInterfaces()` is enough to answer "online" without shelling out. A full
    // SSID / Wi-Fi list is a Milestone 2 concern (quick panels); the shell's "are we
    // connected" check works either way.
    const interfaces = os.networkInterfaces()
    const online = Object.values(interfaces).some(addrs => addrs?.some(addr => !addr.internal && addr.family === 'IPv4'))

    return { online }
  }

  async calendarToday(): Promise<CalendarResult> {
    // Herald OS uses EventKit on macOS and an EDS bridge on Linux. The Windows bridge is a
    // Milestone 2 concern (WinRT Calendar contract via PowerShell COM or the bridge plugin's
    // `HostAdapter`). Until then, say so honestly.
    return { status: 'unavailable', events: [] }
  }

  async recentFiles(): Promise<RecentFile[]> {
    return []
  }

  async findFiles(): Promise<RecentFile[]> {
    return []
  }

  async thumbnail(): Promise<Buffer | null> {
    return null
  }

  async controlStatus(): Promise<StatusPanelState> {
    throw new HostNotSupported('quick panels')
  }

  async controlAction(): Promise<void> {
    throw new HostNotSupported('quick panels')
  }
}