using System.Runtime.InteropServices;

namespace Herald.WindowsControls;

/// <summary>Reads active monitors from User32 without shelling out or changing display state.</summary>
public static class WindowsDisplayStatus
{
    private const uint MonitorInfofPrimary = 1;

    public static DisplayResult Read()
    {
        var monitors = new List<DisplayMonitor>();
        if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (handle, _, _, _) =>
        {
            var info = new MonitorInfoEx { CbSize = Marshal.SizeOf<MonitorInfoEx>() };
            if (GetMonitorInfo(handle, ref info))
            {
                var bounds = info.RcMonitor;
                monitors.Add(new DisplayMonitor(info.SzDevice.TrimEnd('\0'), bounds.Left, bounds.Top,
                    bounds.Right - bounds.Left, bounds.Bottom - bounds.Top, (info.DwFlags & MonitorInfofPrimary) != 0));
            }
            return true;
        }, IntPtr.Zero)) throw new InvalidOperationException("EnumDisplayMonitors failed.");
        return new DisplayResult(monitors);
    }

    private delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MonitorInfoEx
    {
        public int CbSize;
        public Rect RcMonitor;
        public Rect RcWork;
        public uint DwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string SzDevice;
    }
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc callback, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfoEx monitorInfo);
}
