import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const POSIX_FALLBACK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
const WINDOWS_FALLBACK_DIRS = [
  'C:\\Windows\\System32',
  'C:\\Windows',
  'C:\\Windows\\System32\\Wbem',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0'
]

/** The directory `hermes.exe` and the Python interpreter live in under the managed install. */
function managedHermesScriptsDir(): string {
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')

  return path.join(localAppData, 'hermes', 'hermes-agent', 'Scripts')
}

/**
 * The PATH the spawned `hermes serve` should see. On macOS and Linux the GUI process inherits a
 * minimal PATH that is missing the user's CLI tools; we ask the login shell for the user's PATH
 * and merge with sane fallbacks. On Windows we do not spawn a shell at all — `hermes.exe` and the
 * Python interpreter live under the managed install's `Scripts\` directory and the user's PATH
 * already covers system utilities (Electron passes the parent's `PATH` through).
 */
export async function loginShellPath(timeoutMs = 4000): Promise<string> {
  const seen = new Set<string>()
  const merged: string[] = []

  for (const dir of [
    ...await resolveShellLoginPath(timeoutMs),
    ...(process.env.PATH ?? '').split(path.delimiter),
    path.join(os.homedir(), '.local', 'bin'),
    ...(process.platform === 'win32' ? [...WINDOWS_FALLBACK_DIRS, managedHermesScriptsDir()] : POSIX_FALLBACK_DIRS)
  ]) {
    if (dir && !seen.has(dir)) {
      seen.add(dir)
      merged.push(dir)
    }
  }

  return merged.join(path.delimiter)
}

async function resolveShellLoginPath(timeoutMs: number): Promise<string[]> {
  if (process.platform === 'win32') {
    // The Windows PATH is fully inherited; the managed Hermes install's Scripts directory is
    // added below by the fallback list. Spawning cmd.exe or PowerShell here would only add
    // latency and (for PowerShell) a visible console window.
    return []
  }

  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')

  return new Promise<string[]>(resolve => {
    execFile(shell, ['-lc', 'printf "%s" "$PATH"'], { timeout: timeoutMs }, (error, stdout) => {
      resolve(error ? [] : stdout.trim().split(path.delimiter).filter(Boolean))
    })
  })
}
