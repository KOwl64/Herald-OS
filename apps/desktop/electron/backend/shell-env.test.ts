import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loginShellPath } from './shell-env.ts'

const originalEnv = { ...process.env }
const originalPlatform = process.platform

describe('loginShellPath', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('returns the inherited PATH plus Windows fallbacks on win32 (no shell is spawned)', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env = {
      ...originalEnv,
      PATH: 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      SHELL: '/bin/bash'
    }

    const start = Date.now()
    const result = await loginShellPath()
    const elapsed = Date.now() - start

    // The win32 path must not shell out to /bin/bash; a healthy call returns within 500ms.
    expect(elapsed).toBeLessThan(500)
    expect(result).toContain('C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps')
    expect(result).toContain('C:\\Windows\\System32')
    expect(result).toContain('C:\\Windows\\System32\\Wbem')
    expect(result).toContain('C:\\Windows\\System32\\WindowsPowerShell\\v1.0')
    expect(result).toContain('C:\\Users\\me\\AppData\\Local\\hermes\\hermes-agent\\Scripts')
    expect(result).toContain(path.join(originalEnv.USERPROFILE ?? originalEnv.HOME ?? '', '.local', 'bin'))
    // POSIX-only fallbacks must never leak into a Windows PATH.
    expect(result).not.toContain('/opt/homebrew/bin')
    expect(result).not.toContain('/usr/bin')
  })

  it('uses path.delimiter to join segments on win32', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env = {
      ...originalEnv,
      PATH: 'A;B',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local'
    }

    const result = await loginShellPath()
    const parts = result.split(path.delimiter)

    expect(parts[0]).toBe('A')
    expect(parts[1]).toBe('B')
    expect(parts.length).toBeGreaterThan(2)
  })

  it('does not block on a shell spawn when running on win32', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env = {
      ...originalEnv,
      PATH: 'C:\\Windows\\System32',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      SHELL: '/bin/bash'
    }

    const start = Date.now()
    await loginShellPath()
    // If the implementation regressed to spawn bash on Windows, this test would visibly fail in CI.
    expect(Date.now() - start).toBeLessThan(500)
  })
})