# Windows controls helper

This .NET 10, Windows-only console helper is the native boundary for Herald OS quick-panel controls. It reads newline-delimited JSON from standard input and writes exactly one newline-delimited JSON response per input line to standard output. It never interprets input as a command, launches a shell, or emits diagnostics to standard output.

## Supported protocol

Requests have one field, `verb`. The fixed allowlist is:

- `battery.status` — implemented using the documented Win32 `GetSystemPowerStatus` API.
- `audio.status`, `bluetooth.status`, and `display.status` — recognized but return an explicit `not_supported` error until their native Windows integrations are implemented.

Unknown verbs and malformed requests return `invalid_request`; they are never passed to a command interpreter. A response is either `{ "ok": true, "result": ... }` or `{ "ok": false, "error": { "code": ..., "message": ... } }`.

Example:

```powershell
'{"verb":"battery.status"}' | dotnet run --project .\Herald.WindowsControls\Herald.WindowsControls.csproj
```

## Build and test

From this directory, with the .NET 10 SDK installed:

```powershell
dotnet build .\Herald.WindowsControls\Herald.WindowsControls.csproj -c Release
dotnet run --project .\Herald.WindowsControls.Tests\Herald.WindowsControls.Tests.csproj -c Release
```

The test executable exercises the pure allowlist/dispatch logic without calling Win32. The actual power-status reader is intentionally a small direct P/Invoke, so it can be integrated by Electron main without a PowerShell or command-line parsing layer.
