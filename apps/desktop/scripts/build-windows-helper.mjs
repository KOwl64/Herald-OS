#!/usr/bin/env node
// Build the Herald.WindowsControls native helper for every Windows RID the NSIS installer ships
// for. The packaged app expects one subdirectory per architecture (windows-controls-x64 and
// windows-controls-arm64) so a single installer can run on either Windows architecture — the
// Electron host picks the matching one at runtime via process.arch.
//
// On non-Windows hosts this script is a no-op: the helper only runs on Windows and the NSIS
// build is only triggered by `npm run dist:win` from a Windows machine.
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import process from 'node:process'

const PROJECT = 'native/windows-controls/Herald.WindowsControls/Herald.WindowsControls.csproj'
// [arch segment used in the directory name, dotnet RID]
const TARGETS = [['x64', 'win-x64'], ['arm64', 'win-arm64']]

if (process.platform !== 'win32') {
  console.log('build-windows-helper: skipped (not running on Windows)')
  process.exit(0)
}

for (const [arch, rid] of TARGETS) {
  const out = `build/windows-controls-${arch}`
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  console.log(`build-windows-helper: dotnet publish ${arch} -> ${out}`)
  execSync(`dotnet publish ${PROJECT} -c Release -r ${rid} --self-contained true -p:PublishSingleFile=true -o ${out}`, { stdio: 'inherit' })
}
