"""Pure contracts for the Windows bridge parser; tests never invoke Windows commands."""

from __future__ import annotations

import importlib


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
