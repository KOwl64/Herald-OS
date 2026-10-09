"""Windows host adapter: typed stub. See docs/internal/ROADMAP.md for the planned implementation
(PowerShell ``Get-Process``, ``Get-NetTCPConnection``, Windows Search, ``Start-Process``)."""

from __future__ import annotations

import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Literal, Sequence

from ..documents import DocumentText
from ..util import run
from .base import AppInfo, FileSearch, FoundFile, HostAdapter, HostNotSupported, PortListener, ProcessRow

_MESSAGE = "The Herald OS system bridge does not support Windows yet."
_START_MENU_DIRS = (
    Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData")) / "Microsoft/Windows/Start Menu/Programs",
    Path(os.environ.get("APPDATA", "")) / "Microsoft/Windows/Start Menu/Programs",
)

# The bridge deliberately searches only user-facing profile folders instead of recursively
# walking a drive.  That keeps a read-only convenience tool bounded and prevents it from
# exposing system or other-user files.
WINDOWS_SEARCH_FOLDERS = ("Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music")
MAX_FILE_SEARCH_ENTRIES = 10_000
MAX_FILE_SEARCH_CANDIDATES = 2_000
_SCREENSHOT_NAME = re.compile(r"screenshot|screen shot|screencapture|captura", re.IGNORECASE)
_KIND_EXTENSIONS: dict[str, tuple[str, ...]] = {
    "image": ("png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "svg", "tif", "tiff", "avif"),
    "screenshot": ("png", "jpg", "jpeg", "webp"),
    "document": ("pdf", "doc", "docx", "odt", "rtf", "txt", "md", "pages", "xls", "xlsx", "ods", "ppt", "pptx", "odp", "epub"),
    "pdf": ("pdf",),
    "video": ("mp4", "mkv", "mov", "avi", "webm", "m4v", "mpg", "mpeg", "wmv"),
    "audio": ("mp3", "wav", "flac", "ogg", "oga", "m4a", "aac", "opus", "wma"),
    "code": ("py", "js", "ts", "tsx", "jsx", "go", "rs", "c", "h", "cpp", "hpp", "java", "rb", "sh", "swift", "kt", "php", "html", "css", "json", "yaml", "yml", "toml", "sql", "lua"),
    "archive": ("zip", "tar", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar"),
}


def search_extensions(search: FileSearch) -> set[str]:
    """Lower-case extensions (without dots) allowed by a Windows file search."""
    extensions = {extension.lstrip(".").lower() for extension in search.extensions if extension}
    kind_extensions = set(_KIND_EXTENSIONS.get(search.kind or "any", ()))
    return extensions & kind_extensions if extensions and kind_extensions else (extensions or kind_extensions)


def search_time_bounds(search: FileSearch) -> tuple[float | None, float | None]:
    """Convert inclusive ``since`` and end-of-day ``until`` dates to timestamps."""
    def to_epoch(value: str, end_of_day: bool) -> float:
        try:
            timestamp = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
            if end_of_day and len(value.strip()) == 10:
                timestamp += timedelta(days=1)
        except ValueError as exc:
            raise ValueError(f"invalid date '{value}' (use YYYY-MM-DD or ISO 8601)") from exc
        return timestamp.timestamp()

    return (to_epoch(search.since, False) if search.since else None,
            to_epoch(search.until, True) if search.until else None)


def _is_within(path: str, parent: str) -> bool:
    try:
        return os.path.commonpath((path, parent)) == parent
    except ValueError:  # Different drives on Windows.
        return False


def search_roots(query: FileSearch, home: Path | None = None) -> list[Path]:
    """Return existing, safe roots for a Windows file search."""
    profile = os.path.realpath(os.fspath(home or Path.home()))
    if query.scope:
        scope = os.path.realpath(os.path.abspath(os.path.expanduser(query.scope)))
        if not _is_within(scope, profile):
            raise ValueError("file search scope must be inside the current user's profile")
        return [Path(scope)] if os.path.isdir(scope) else []
    return [Path(profile, name) for name in WINDOWS_SEARCH_FOLDERS if os.path.isdir(os.path.join(profile, name))]


def matches_file_search(path: str, query: FileSearch, *, is_dir: bool, mtime: float | None,
                        bounds: tuple[float | None, float | None] | None = None) -> bool:
    """Apply ``FileSearch`` predicates to a Windows candidate path (pure)."""
    name = Path(path).name
    lower = name.lower()
    kind = query.kind or "any"
    if kind == "folder":
        if not is_dir:
            return False
    elif kind != "any" and is_dir:
        return False
    if query.name and query.name.lower() not in lower:
        return False
    if query.text and query.text.lower() not in lower:
        return False
    extensions = search_extensions(query)
    if extensions:
        extension = lower.rsplit(".", 1)[1] if "." in lower else ""
        if is_dir or extension not in extensions:
            return False
    if kind == "screenshot" and not _SCREENSHOT_NAME.search(name):
        return False
    since, until = bounds if bounds is not None else search_time_bounds(query)
    if (since is not None or until is not None) and mtime is None:
        return False
    if since is not None and mtime is not None and mtime < since:
        return False
    return not (until is not None and mtime is not None and mtime >= until)


def _rows(value: str) -> list[dict[str, Any]]:
    """PowerShell emits an object for one row and an array for many; normalize both."""
    try:
        decoded = json.loads(value) if value.strip() else None
    except json.JSONDecodeError:
        return []
    if isinstance(decoded, list):
        return [row for row in decoded if isinstance(row, dict)]
    return [decoded] if isinstance(decoded, dict) else []


def parse_processes(value: str) -> list[ProcessRow]:
    """Map the stable ``Win32_Process`` JSON shape to the bridge's process contract."""
    rows: list[ProcessRow] = []
    for item in _rows(value):
        try:
            pid = int(item.get("ProcessId") or 0)
        except (TypeError, ValueError):
            continue
        if not pid:
            continue
        try:
            ppid, rss = int(item.get("ParentProcessId") or 0), int(item.get("WorkingSetSize") or 0)
        except (TypeError, ValueError):
            ppid, rss = 0, 0
        rows.append(ProcessRow(pid=pid, ppid=ppid, user="", cpu_percent=0.0, mem_percent=0.0, rss_bytes=rss,
                               command=str(item.get("ExecutablePath") or item.get("Name") or "unknown")))
    return rows


def parse_disks(value: str) -> list[dict[str, Any]]:
    disks: list[dict[str, Any]] = []
    for item in _rows(value):
        try:
            total, free = int(item.get("Size") or 0), int(item.get("FreeSpace") or 0)
        except (TypeError, ValueError):
            continue
        mount = str(item.get("DeviceID") or "")
        if mount:
            disks.append({"mount": mount, "total_bytes": total, "used_bytes": max(0, total - free), "free_bytes": free})
    return disks


def _powershell(script: str, timeout: float = 15.0):
    """Run fixed inventory scripts; user values never enter a PowerShell command string."""
    return run(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], timeout=timeout)


class WindowsHost(HostAdapter):
    platform = "win32"

    def available(self) -> bool:
        return sys.platform.startswith("win")

    def _processes(self) -> list[ProcessRow]:
        result = _powershell("Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,ExecutablePath | ConvertTo-Json -Compress", 30)
        if not result.ok:
            raise RuntimeError(result.stderr.strip() or "could not list Windows processes")
        return parse_processes(result.stdout)

    def system_info(self) -> dict[str, Any]:
        result = _powershell("$os=Get-CimInstance Win32_OperatingSystem; $disks=Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3'; [pscustomobject]@{Caption=$os.Caption;Version=$os.Version;Build=$os.BuildNumber;TotalKiB=$os.TotalVisibleMemorySize;FreeKiB=$os.FreePhysicalMemory;Disks=@($disks | Select-Object DeviceID,Size,FreeSpace)} | ConvertTo-Json -Depth 4 -Compress")
        if not result.ok:
            raise RuntimeError(result.stderr.strip() or "could not read Windows system information")
        data = _rows(result.stdout)
        if not data:
            raise RuntimeError("Windows returned invalid system information")
        info = data[0]
        total, free = int(info.get("TotalKiB") or 0) * 1024, int(info.get("FreeKiB") or 0) * 1024
        return {"os": str(info.get("Caption") or "Windows"), "build": f"{info.get('Version') or ''} ({info.get('Build') or ''})".strip(),
                "hostname": platform.node(), "arch": platform.machine(), "chip": platform.processor() or None, "cpu_cores": os.cpu_count() or 0,
                "memory_total_bytes": total, "memory_used_bytes": max(0, total - free), "load_average": None, "uptime_seconds": None,
                "disks": parse_disks(json.dumps(info.get("Disks") or [])), "battery": None,
                "user": os.environ.get("USERNAME"), "home": str(Path.home())}

    def list_processes(self, sort: Literal["cpu", "memory"], limit: int) -> list[ProcessRow]:
        rows = self._processes()
        rows.sort(key=lambda row: row.rss_bytes if sort == "memory" else row.cpu_percent, reverse=True)
        return rows[:limit]

    def find_processes(self, name: str, limit: int) -> list[ProcessRow]:
        needle = name.lower()
        return [row for row in self._processes() if needle in row.command.lower()][:limit]

    def listeners_on_port(self, port: int) -> list[PortListener]:
        result = _powershell(f"Get-NetTCPConnection -State Listen -LocalPort {int(port)} -ErrorAction SilentlyContinue | Select-Object LocalPort,OwningProcess | ConvertTo-Json -Compress")
        if not result.ok:
            return []
        names = {row.pid: row.name for row in self._processes()}
        listeners: list[PortListener] = []
        for item in _rows(result.stdout):
            try:
                pid, actual_port = int(item.get("OwningProcess") or 0), int(item.get("LocalPort") or port)
            except (TypeError, ValueError):
                continue
            listeners.append(PortListener(pid=pid, command=names.get(pid, "unknown"), user="", port=actual_port, protocol="tcp"))
        return listeners

    def disk_usage(self, path: Path, depth: int, limit: int, timeout: float) -> dict[str, Any]:
        started, entries = time.monotonic(), []
        try:
            children = list(path.iterdir())
        except OSError as exc:
            raise RuntimeError(f"could not read {path}: {exc}") from exc
        for child in children:
            if time.monotonic() - started >= timeout:
                break
            try:
                size = sum(item.stat().st_size for item in child.rglob("*") if item.is_file() and not item.is_symlink()) if child.is_dir() and not child.is_symlink() else child.stat().st_size
                entries.append((size, child))
            except OSError:
                continue
        return {"path": str(path), "total_bytes": sum(size for size, _ in entries), "timed_out": time.monotonic() - started >= timeout,
                "entries": [{"path": str(child), "bytes": size} for size, child in sorted(entries, key=lambda entry: entry[0], reverse=True)[:limit]], "note": None}

    def find_files(self, query: FileSearch) -> list[FoundFile]:
        kind = query.kind or "any"
        if not any((query.text, query.name, kind != "any", query.since, query.until, query.extensions)):
            raise ValueError("search needs at least one of: text, name, kind, since/until, extensions")

        bounds = search_time_bounds(query)  # Validate dates before reading folders.
        candidate_cap = min(MAX_FILE_SEARCH_CANDIDATES, max(200, query.limit * 40))
        inspected = 0
        candidates: list[FoundFile] = []
        pending = list(reversed(search_roots(query)))
        while pending and inspected < MAX_FILE_SEARCH_ENTRIES and len(candidates) < candidate_cap:
            directory = pending.pop()
            try:
                with os.scandir(directory) as entries:
                    for entry in entries:
                        if inspected >= MAX_FILE_SEARCH_ENTRIES or len(candidates) >= candidate_cap:
                            break
                        inspected += 1
                        try:
                            # Links and junctions can leave the profile; never follow them.
                            if entry.is_symlink():
                                continue
                            is_dir = entry.is_dir(follow_symlinks=False)
                            stat = entry.stat(follow_symlinks=False)
                        except OSError:
                            continue
                        if matches_file_search(entry.path, query, is_dir=is_dir, mtime=stat.st_mtime, bounds=bounds):
                            candidates.append(FoundFile(
                                path=entry.path, size=stat.st_size,
                                modified=datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
                                kind="folder" if is_dir else "file",
                            ))
                        if is_dir:
                            pending.append(Path(entry.path))
            except OSError:
                # Permission-denied and transient entries are expected; this remains a partial,
                # read-only search without disclosing inaccessible file names.
                continue
        candidates.sort(key=lambda item: item.modified or "", reverse=True)
        return candidates[:max(1, query.limit)]

    def installed_apps(self) -> list[AppInfo]:
        apps: dict[str, AppInfo] = {}
        for directory in _START_MENU_DIRS:
            if directory.is_dir():
                for shortcut in directory.rglob("*.lnk"):
                    apps.setdefault(shortcut.stem.lower(), AppInfo(name=shortcut.stem, path=str(shortcut)))
        return sorted(apps.values(), key=lambda app: app.name.lower())

    def running_apps(self) -> list[AppInfo]:
        return [AppInfo(name=row.name, path=row.command, running=True, pid=row.pid) for row in self._processes()]

    def open_app(self, name: str, args: Sequence[str] = ()) -> None:
        app = self.resolve_app(name)
        target = app.path if app else shutil.which(name)
        if not target:
            raise RuntimeError(f"no application named {name!r}")
        subprocess.Popen([target, *args], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def open_url(self, url: str, app: str | None = None) -> None:
        if app:
            self.open_app(app, [url])
            return
        os.startfile(url)  # type: ignore[attr-defined]  # Windows' registered URL handler.

    def open_path(self, path: Path, app: str | None = None) -> None:
        if app:
            self.open_app(app, [str(path)])
            return
        os.startfile(str(path))  # type: ignore[attr-defined]  # Windows Explorer file association.

    def reveal(self, path: Path) -> None:
        subprocess.Popen(["explorer.exe", f"/select,{path}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def quit_app(self, name: str, force: bool) -> None:
        rows = [row for row in self._processes() if name.lower() in row.command.lower()]
        if not rows:
            raise RuntimeError(f"{name} is not running")
        for row in rows:
            result = run(["taskkill", "/PID", str(row.pid), *(["/F"] if force else [])], timeout=10)
            if not result.ok:
                raise RuntimeError(result.stderr.strip() or f"could not quit {name}")

    def read_document(self, path: Path, max_pages: int, ocr: bool) -> DocumentText:
        raise HostNotSupported(_MESSAGE)

    def network_status(self) -> dict[str, Any]:
        result = _powershell("Get-NetConnectionProfile | Select-Object InterfaceAlias,IPv4Connectivity,IPv6Connectivity | ConvertTo-Json -Compress")
        if not result.ok:
            return {"online": False, "note": "Windows network status is unavailable."}
        profiles = _rows(result.stdout)
        return {"online": any(
            str(profile.get(field) or "").lower() == "internet"
            for profile in profiles
            for field in ("IPv4Connectivity", "IPv6Connectivity")
        )}

    def bluetooth_status(self) -> dict[str, Any]:
        raise HostNotSupported(_MESSAGE)

    def audio_status(self) -> dict[str, Any]:
        raise HostNotSupported(_MESSAGE)

    def appearance_status(self) -> dict[str, Any]:
        raise HostNotSupported(_MESSAGE)

    def system_logs(self, minutes: int, level: str, process: str | None, limit: int) -> list[str]:
        raise HostNotSupported(_MESSAGE)

    def set_volume(self, percent: int | None, muted: bool | None) -> dict[str, Any]:
        raise HostNotSupported(_MESSAGE)

    def set_dark_mode(self, enabled: bool) -> None:
        raise HostNotSupported(_MESSAGE)

    def open_settings(self, pane: str) -> str:
        raise HostNotSupported(_MESSAGE)

    def lock_screen(self) -> None:
        raise HostNotSupported(_MESSAGE)

    def sleep_display(self) -> None:
        raise HostNotSupported(_MESSAGE)

    def set_wifi_power(self, enabled: bool) -> None:
        raise HostNotSupported(_MESSAGE)

    def kill(self, pid: int, force: bool) -> None:
        result = run(["taskkill", "/PID", str(pid), *(["/F"] if force else [])], timeout=10)
        if not result.ok:
            raise RuntimeError(result.stderr.strip() or f"could not stop process {pid}")

    def trash(self, paths: Sequence[Path]) -> None:
        raise HostNotSupported(_MESSAGE)

    def notify(self, title: str, body: str) -> None:
        raise HostNotSupported(_MESSAGE)
