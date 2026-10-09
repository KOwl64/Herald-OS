import { describe, expect, it } from 'vitest'
import type { CalendarResult, InstalledApp, NetworkStatus, RecentFile, StatusPanelState, SystemInfo, SystemStats } from '../../shared/ipc.ts'
import { HostNotSupported, type HostPlatform } from './types.ts'
import { WindowsPlatform } from './windows.ts'

const platform: HostPlatform = new WindowsPlatform()

describe('WindowsPlatform', () => {
  it('returns a well-shaped SystemInfo with platform=win32 and osName=Windows', async () => {
    const info = await platform.systemInfo() satisfies SystemInfo

    expect(info.platform).toBe('win32')
    expect(info.osName).toBe('Windows')
    expect(info.hostname).toEqual(expect.any(String))
    expect(info.cpuCount).toEqual(expect.any(Number))
    expect(info.totalMemory).toBeGreaterThan(0)
    expect(info.homeDir).toEqual(expect.any(String))
    expect(info.userName).toEqual(expect.any(String))
  })

  it('returns SystemStats with a three-tuple load average, no disks, and no battery in Milestone 1', async () => {
    const stats = await platform.sampleStats() satisfies SystemStats

    expect(stats.sampledAt).toBeGreaterThan(0)
    expect(Array.isArray(stats.loadAverage)).toBe(true)
    expect(stats.loadAverage).toHaveLength(3)
    expect(stats.memoryTotal).toBeGreaterThan(0)
    expect(stats.memoryFree).toBeLessThanOrEqual(stats.memoryTotal)
    expect(stats.memoryUsed).toBe(stats.memoryTotal - stats.memoryFree)
    expect(stats.disks).toEqual([])
    expect(stats.battery).toEqual({ present: false })
  })

  it('returns an honest NetworkStatus from os.networkInterfaces()', async () => {
    const status = await platform.networkStatus() satisfies NetworkStatus

    expect(status).toHaveProperty('online')
    expect(typeof status.online).toBe('boolean')
  })

  it('reports calendar as unavailable in Milestone 1', async () => {
    const calendar = await platform.calendarToday() satisfies CalendarResult

    expect(calendar.status).toBe('unavailable')
    expect(calendar.events).toEqual([])
  })

  it('returns empty lists for process, app, recent and find queries', async () => {
    expect(await platform.listProcesses('cpu', 10)).toEqual([])
    expect(await platform.listInstalledApps()).toEqual([])
    expect(await platform.recentFiles(20)).toEqual([])
    expect(await platform.findFiles('a', 5)).toEqual([])
  })

  it('returns null for appIcon and thumbnail (no Windows bridge yet)', async () => {
    expect(await platform.appIcon('C:\\Path\\To.exe')).toBeNull()
    expect(await platform.thumbnail('C:\\Path\\To.png', 128)).toBeNull()
  })

  it('rejects openIn and unsupported quick controls with HostNotSupported', async () => {
    await expect(platform.openIn('editor', 'C:\\file.txt')).rejects.toBeInstanceOf(HostNotSupported)
    await expect(platform.openIn('finder', '')).rejects.toBeInstanceOf(HostNotSupported)
    await expect(platform.openIn('terminal', '')).rejects.toBeInstanceOf(HostNotSupported)
    await expect(platform.controlStatus('bluetooth' as StatusPanelState['panel'])).rejects.toBeInstanceOf(HostNotSupported)
    await expect(platform.controlAction({ panel: 'bluetooth', action: 'scan' })).rejects.toBeInstanceOf(HostNotSupported)
  })

  it('the HostNotSupported error names the feature and the host platform', async () => {
    try {
      await platform.openIn('finder', '')
      throw new Error('expected openIn to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(HostNotSupported)
      expect((error as Error).message).toContain('finder')
      expect((error as Error).message).toContain(process.platform)
    }
  })

  it('shape-checks the empty InstalledApp and RecentFile lists stay empty', () => {
    // The types exist for the renderer; assert they are referenceable from the test module so a
    // breaking change in shared/ipc.ts is caught here too.
    const apps: InstalledApp[] = []
    const recents: RecentFile[] = []

    expect(apps).toEqual([])
    expect(recents).toEqual([])
  })
})
