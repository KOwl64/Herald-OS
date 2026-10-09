"""Pure contracts for the Windows bridge parser; tests never invoke Windows commands."""

from __future__ import annotations

import importlib
import os
from datetime import datetime

import pytest


def _windows(plugin):
    return importlib.import_module(plugin.__name__ + ".bridge.host.windows")


def test_parse_processes_keeps_paths_and_memory(plugin):
    windows = _windows(plugin)
    rows = windows.parse_processes('[{"ProcessId":42,"ParentProcessId":1,"Name":"Code.exe","WorkingSetSize":2048,"ExecutablePath":"C:\\\\Program Files\\\\Code\\\\Code.exe"}]')
    assert len(rows) == 1
    assert rows[0].pid == 42 and rows[0].ppid == 1 and rows[0].rss_bytes == 2048
    assert rows[0].command.endswith("Code.exe")


def test_parse_processes_skips_malformed_rows(plugin):
    windows = _windows(plugin)
    assert windows.parse_processes("not json") == []
    assert windows.parse_processes('[{"ProcessId":""},{"ProcessId":"3","Name":"cmd.exe"}]')[0].name == "cmd.exe"


def test_parse_disks_calculates_used_bytes(plugin):
    windows = _windows(plugin)
    disks = windows.parse_disks(r'[{"DeviceID":"C:\\", "Size":1000,"FreeSpace":250}]')
    assert disks == [{"mount": "C:\\", "total_bytes": 1000, "used_bytes": 750, "free_bytes": 250}]


def test_windows_host_is_available_only_on_windows(plugin, monkeypatch):
    windows = _windows(plugin)
    host = windows.WindowsHost()
    monkeypatch.setattr(windows.sys, "platform", "linux")
    assert host.available() is False
    monkeypatch.setattr(windows.sys, "platform", "win32")
    assert host.available() is True


def test_windows_search_predicates_cover_kinds_extensions_and_dates(plugin, tmp_path):
    windows = _windows(plugin)
    base = importlib.import_module(plugin.__name__ + ".bridge.host.base")
    shot = str(tmp_path / "Pictures" / "Screenshot 2026-10-09.png")
    timestamp = datetime(2026, 10, 9, 10, 0).timestamp()
    query = base.FileSearch(kind="screenshot", since="2026-10-09", until="2026-10-09")
    assert windows.matches_file_search(shot, query, is_dir=False, mtime=timestamp)
    assert not windows.matches_file_search(str(tmp_path / "Pictures" / "holiday.png"), query, is_dir=False, mtime=timestamp)
    assert not windows.matches_file_search(shot, query, is_dir=False, mtime=datetime(2026, 10, 10).timestamp())
    assert windows.matches_file_search(str(tmp_path / "notes" / "tax.PDF"), base.FileSearch(kind="pdf", text="tax"), is_dir=False, mtime=None)


def test_windows_search_roots_stay_in_the_current_profile(plugin, tmp_path):
    windows = _windows(plugin)
    base = importlib.import_module(plugin.__name__ + ".bridge.host.base")
    home = tmp_path / "profile"
    documents = home / "Documents"
    documents.mkdir(parents=True)
    outside = tmp_path / "other"
    outside.mkdir()
    assert windows.search_roots(base.FileSearch(kind="document"), home) == [documents]
    assert windows.search_roots(base.FileSearch(kind="document", scope=str(documents)), home) == [documents]
    with pytest.raises(ValueError, match="current user's profile"):
        windows.search_roots(base.FileSearch(kind="document", scope=str(outside)), home)


def test_windows_find_files_is_bounded_and_skips_unrelated_profile_content(plugin, tmp_path, monkeypatch):
    windows = _windows(plugin)
    base = importlib.import_module(plugin.__name__ + ".bridge.host.base")
    home = tmp_path / "profile"
    documents, app_data = home / "Documents", home / "AppData"
    documents.mkdir(parents=True)
    app_data.mkdir(parents=True)
    old, newest = documents / "old-report.txt", documents / "new-report.txt"
    old.write_text("old")
    newest.write_text("new")
    (app_data / "private-report.txt").write_text("must not be searched")
    os.utime(old, (1_000, 1_000))
    os.utime(newest, (2_000, 2_000))
    monkeypatch.setattr(windows.Path, "home", lambda: home)
    found = windows.WindowsHost().find_files(base.FileSearch(name="report", limit=1))
    assert [item.path for item in found] == [str(newest)]
    with pytest.raises(ValueError, match="at least one"):
        windows.WindowsHost().find_files(base.FileSearch())
