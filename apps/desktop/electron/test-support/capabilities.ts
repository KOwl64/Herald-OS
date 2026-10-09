import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/*
 * What the machine running the tests can actually do, rather than what its platform usually can.
 *
 * Several behaviours under test build a symlink as a fixture. On Windows `fs.symlinkSync` needs
 * Developer Mode or an elevated shell: a CI runner is an administrator and has it, an ordinary
 * developer laptop often does not. Probing beats checking `process.platform`, because the test then
 * runs everywhere it can be honest, and is skipped - with the reason stated - only where the fixture
 * genuinely cannot be built. A blanket Windows skip would silently drop coverage on the machines that
 * are best placed to provide it.
 */

let symlinks: boolean | undefined

/** Whether `fs.symlinkSync` works here. Probed once per test run. */
export function canCreateSymlink(): boolean {
  if (symlinks === undefined) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-symlink-probe-'))
    const target = path.join(dir, 'target')
    const link = path.join(dir, 'link')

    fs.writeFileSync(target, 'probe')

    try {
      fs.symlinkSync(target, link)
      // Guard against a filesystem that accepts the call without making a real link.
      symlinks = fs.lstatSync(link).isSymbolicLink()
    } catch {
      symlinks = false
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  return symlinks
}

/** Why a symlink test was skipped, for the test name and any comment that has to explain it. */
export const NO_SYMLINK_REASON = 'needs fs.symlinkSync (Windows: Developer Mode or an elevated shell)'

let executables: boolean | undefined

/**
 * Whether a file written with mode 0o755 keeps that mode here, i.e. whether this filesystem has an
 * executable bit at all. NTFS does not expose one: Node reports 0o666 whatever mode is asked for, so
 * code that selects on `stat.mode & 0o111` - `hookScripts` does - finds nothing there.
 */
export function canCreateExecutable(): boolean {
  if (executables === undefined) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-exec-probe-'))
    const file = path.join(dir, 'probe.sh')

    try {
      fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 })
      executables = (fs.statSync(file).mode & 0o111) !== 0
    } catch {
      executables = false
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  return executables
}