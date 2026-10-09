# Herald OS on Windows — port plan

> Status: **Milestone 1 in flight.** Windows is currently a stub: `electron/platform/index.ts`
> returns `GenericPlatform` on `win32`, the backend's PATH resolver shells out to `/bin/bash`,
> and CI runs only on Ubuntu + macOS. This document lays out what changes and in what order.

## Goal

Run Herald OS as an Electron desktop app **inside Windows 11**, with Windows as the host OS — the
same shape as the macOS app, not a Linux replacement and not a WSL-only solution. The renderer
stays behind the same `HostPlatform → IPC handler → preload → renderer` boundary that already
protects macOS and Linux. **The renderer must never invoke PowerShell, Node APIs, or native
commands directly.** Native work stays in Electron main and is exposed through the existing
`window.heraldOS` capability surface.

Herald OS on Windows is a **consumer** of an upstream Hermes Agent install on Windows (the user's
managed `hermes-agent` under `%LOCALAPPDATA%\hermes\hermes-agent`, or `hermes` on `PATH`), the
same way the macOS/Linux shells are. We do not fork the runtime.

## Where Windows already works (no change needed)

| Concern | Current behaviour | Verdict on Windows |
| --- | --- | --- |
| Hermes home | `paths.ts` already maps `win32` → `%LOCALAPPDATA%\hermes` | OK |
| Runtime resolve | `backend/resolve.ts` already probes `Scripts\python.exe` and `hermes.exe` | OK |
| Backend handshake | `HERMES_BACKEND_READY` parsing, status polling | OK |
| Renderer preload | `contextBridge.exposeInMainWorld`, typed IPC channels | OK |
| `BrowserWindow` lifecycle | Cross-platform; `screen.getPrimaryDisplay()` works | OK |
| `electron-builder` runs (Linux) | Cross-platform | OK |
| macOS-only code | Gated by `=== 'darwin'` (`darwin.ts`, `darwin-controls.ts`, `EmojiPanel`) | Inert on Windows |
| Linux-only code | Gated by `=== 'linux'` (`linux.ts`, `linux-controls.ts`, `PanelShell`, `Omarchy`, compositor clients, session XDG paths) | Inert on Windows |
| `process.platform === 'win32'` paths | Already in `paths.ts` and `resolve.ts` | OK |

The architecture is genuinely platform-agnostic. The Windows port is mostly **filling the stub
host implementation, fixing two runtime-spawn bugs, and turning CI on**.

## Milestones

### Milestone 1 — boot, wire, do not break the others *(this PR)*

1. **Electron app starts on Windows.** Implement `WindowsPlatform` (inherits `HostPlatform`),
   wire it into `platform/index.ts`, return a `GenericPlatform`-shaped stub where there is no
   native bridge yet (process list, thumbnail, app launch → `HostNotSupported` with the right
   hint, calendar → `unavailable`).
2. **Connect to a native Windows Hermes.** `paths.ts`, `backend/resolve.ts`, and the
   `BackendManager` ladder already work on `win32`. **Fix `backend/shell-env.ts`** so
   `loginShellPath()` does not shell out to `/bin/bash` on Windows — use `process.env.PATH`
   plus well-known Windows bins, and call out `%LOCALAPPDATA%\hermes\hermes-agent\Scripts\`
   when the managed install is present. This is the only blocker between the shell and the
   backend's `hermes serve`.
3. **Preserve macOS/Linux.** No file outside `platform/windows.ts`, `platform/index.ts`,
   `backend/shell-env.ts`, `platform/windows.test.ts`, `backend/shell-env.test.ts`, and
   `.github/workflows/ci.yml` should be touched. The renderer never sees PowerShell because
   `WindowsPlatform` exposes only capabilities, never a shell.
4. **Renderer boundary.** No change. The renderer continues to use `window.heraldOS`; every
   new Windows-only main-process helper is reached via a new IPC channel (or the existing
   ones), never by a direct call.
5. **Tests + CI smoke.** Add `platform/windows.test.ts` covering the host contract (system
   info shape, `HostNotSupported` on unimplemented methods, calendar `unavailable`). Add
   `backend/shell-env.test.ts` for the Windows PATH resolver. Extend `.github/workflows/ci.yml`
   to run the typecheck + vitest + bundle on `windows-latest`; this is the smoke check. It
   does not start Electron, because the GitHub runner does not have a Hermes install.
6. **No packaging.** No `dist:win`, no `electron-builder --win`, no installer assertions.
   `scripts/bundle-electron.mjs` is enough to prove the bundle step works on Windows.
7. **No secrets.** `.env` files, API keys, `%LOCALAPPDATA%` paths, and personal tokens
   stay out of git. The existing `scripts/check-secrets.sh` covers the rest.

### Milestone 2 — make the host feel like Windows (not yet)

- `HostAdapter` Python plugin (`plugins/herald-os-bridge/host/windows.py`) with real
  implementations: `tasklist` / `wmic` for processes, `Get-PSDrive` for disks, `Get-Item`
  recents, PowerShell `Show-ItemInFolder` / `Start-Process` for launch + reveal, and
  thumbnail via `Microsoft.Windows.Imaging`.
- File-watcher back-end swap (`ReadDirectoryChangesW`) where `fs.watch` is unreliable.
- A `WindowsCompositor` (`electron/wm/windows.ts`) only if we want the renderer-driven WM
  on top of bare Win32; default to letting Windows manage the shell window.
- Quick-panel quick controls (`electron/platform/windows-controls.ts`): Wi-Fi via
  `netsh`, Bluetooth via PowerShell, audio via `NAudio`/COM, displays via
  `EnumDisplaySettings`.
- `BackendManager.parentPid` for win32 (replaces the `ps` shell-out).

### Milestone 3 — installer *(not yet)*

- `electron-builder --win nsis` target (x64 + arm64).
- Bridge plugin staged into `extraResources` the way the macOS bundle does today.
- `apps/desktop/build/entitlements.win.plist` analogue (`appxmanifest`, signing config).
- Microsoft Store / winget manifest.

### Out of scope

- WSL-hosted code. Herald OS on Windows uses the **Windows-native** Hermes Agent; it does
  not require WSL, does not run a Linux VM, and does not depend on niri or greetd.
- Voice on Windows. Voice on Windows needs an ASR plan we have not picked; tracked
  separately under `docs/VOICE.md`.
- Herald OS Linux features that Windows does not have a Windows equivalent for (greetd
  session, niri panels mode, Omarchy theme follow). They stay Linux-only by gating on
  `process.platform === 'linux'`.

## Milestone 1 — concrete work

| File | Change |
| --- | --- |
| `apps/desktop/electron/platform/windows.ts` | **new** — implements `HostPlatform` on `win32` |
| `apps/desktop/electron/platform/index.ts` | add `case 'win32': return new WindowsPlatform()` |
| `apps/desktop/electron/backend/shell-env.ts` | branch on `process.platform === 'win32'`; never shell out to `/bin/bash` |
| `apps/desktop/electron/backend/shell-env.test.ts` | **new** — covers the Windows and macOS/Linux branches |
| `apps/desktop/electron/platform/windows.test.ts` | **new** — covers the host contract and `HostNotSupported` shapes |
| `.github/workflows/ci.yml` | add `windows-latest` to the `shell` matrix |
| `docs/WINDOWS-PORT.md` | **new** — this file |

No renderer is touched. The preload, the IPC channels, and `window.heraldOS` are unchanged.

## Validation for Milestone 1

Run from `C:\Projects\HeraldOS`:

1. `node "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js" ci`
2. `node "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js" run typecheck`
3. `node "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js" test`
4. `node "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js" run build` (runs `vite build && bundle-electron.mjs`; the bundle is the local "smoke" — proves esbuild produces a main + preload on Windows)

Commit in small, clearly named commits. The CI `windows-latest` job runs the same four
steps; that is the Windows smoke check for this milestone. A real on-machine launch is a
Milestone 3 concern (the install step is gated by the installer we have not built).

## Risks and what we are *not* promising

- `electron-builder --win nsis` is **not** in this milestone. No installer, no signed
  bundle, no Store artefact.
- The shell is the desktop-mode single window on Windows (no panels mode, no kiosk
  compositor mode). It runs as a regular Win32 application over the user's normal Windows
  desktop.
- **Event hooks do not run on Windows.** `hookScripts` (`electron/events/hooks.ts`) selects
  on `stat.mode & 0o111`, and NTFS has no executable bit: Node reports `0o666` for a file
  written with mode `0o755`, so the filter matches nothing and `hookScripts` returns `[]` for
  every file. Bypassing the filter alone would not be enough — `spawn(script)` cannot execute
  a `.sh` on Windows without a shell either. Fixing this needs a decision about how a Windows
  host invokes a hook (shebang, `PATHEXT`, or an explicit shell), which is a product decision
  outside this milestone. `electron/events/sources.test.ts` pins the current behaviour and says
  so in the test name, so the day this is fixed the suite says so first.
- The host capabilities that have no Windows source yet return `HostNotSupported` with a
  short hint. The renderer already renders that case honestly; nothing about Milestone 1
  changes the renderer.
- We do not run a full Electron smoke in CI (no Hermes install on the runner). Milestone 1
  stops at typecheck + vitest + bundle. A real on-machine start is documented in
  `apps/desktop/README.md` once Milestone 2 is in.