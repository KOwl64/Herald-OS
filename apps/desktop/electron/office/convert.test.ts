import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { convertArgs, convertWithLibreOffice, sofficeCandidates } from './convert.ts'

/*
 * `sofficeCandidates` and `convertArgs` are pure, and they are asked about other platforms: the
 * darwin and Linux cases must hold whatever host runs the suite. So the expectations here are built
 * the same way the code builds them - with `path.delimiter` and `path.join` - rather than with POSIX
 * literals that only mean anything on a POSIX host. That keeps every assertion on every platform
 * instead of skipping the file wherever the separators differ.
 */

describe('sofficeCandidates', () => {
  it('tries the app bundle on the Mac before PATH', () => {
    const list = sofficeCandidates('darwin', { PATH: ['/opt/homebrew/bin', '/usr/bin'].join(path.delimiter) }, '/Users/me')

    expect(list[0]).toBe('/Applications/LibreOffice.app/Contents/MacOS/soffice')
    expect(list[1]).toBe(path.join('/Users/me', 'Applications', 'LibreOffice.app', 'Contents', 'MacOS', 'soffice'))
    expect(list).toContain(path.join('/opt/homebrew/bin', 'soffice'))
    // Both PATH entries are offered, soffice before libreoffice within each.
    expect(list.indexOf(path.join('/opt/homebrew/bin', 'soffice'))).toBeLessThan(list.indexOf(path.join('/opt/homebrew/bin', 'libreoffice')))
    expect(list.indexOf(path.join('/usr/bin', 'soffice'))).toBeLessThan(list.indexOf(path.join('/usr/bin', 'libreoffice')))
  })

  it('tries PATH first on Linux, then the usual install places and Flatpak', () => {
    const list = sofficeCandidates('linux', { PATH: ['/usr/local/bin', '/usr/bin'].join(path.delimiter) })

    expect(list.slice(0, 2)).toEqual([path.join('/usr/local/bin', 'soffice'), path.join('/usr/local/bin', 'libreoffice')])
    // The fixed install places are returned verbatim, so they are the same string on any host.
    expect(list).toContain('/usr/lib/libreoffice/program/soffice')
    expect(list.at(-1)).toBe('/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice')
  })

  it('offers nothing from an empty PATH', () => {
    expect(sofficeCandidates('linux', {})).toEqual([
      '/usr/bin/soffice',
      '/usr/lib/libreoffice/program/soffice',
      '/opt/libreoffice/program/soffice',
      '/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice'
    ])
  })
})

describe('convertArgs', () => {
  it('runs headless with a profile of its own', () => {
    const profile = path.join(os.tmpdir(), 'herald-profile')
    const args = convertArgs(path.join(os.tmpdir(), 'in', 'Plan.odt'), 'docx', path.join(os.tmpdir(), 'out'), profile)

    // The profile is a file URL, not a bare path: LibreOffice takes -env:UserInstallation that way.
    expect(args[0]).toBe(`-env:UserInstallation=${pathToFileURL(profile).href}`)
    expect(args[0]).toMatch(/^-env:UserInstallation=file:\/\/\//)
    expect(args.slice(1)).toEqual([
      '--headless',
      '--norestore',
      '--nologo',
      '--nolockcheck',
      '--convert-to',
      'docx',
      '--outdir',
      path.join(os.tmpdir(), 'out'),
      path.join(os.tmpdir(), 'in', 'Plan.odt')
    ])
  })
})

describe('convertWithLibreOffice', () => {
  it('refuses formats it does not convert to', async () => {
    await expect(convertWithLibreOffice(path.join(os.tmpdir(), 'a.odt'), 'exe')).rejects.toThrow('not asked for .exe')
  })
})