using System.Runtime.InteropServices;

namespace Herald.WindowsControls;

/// <summary>Enumerates local Bluetooth radios through the documented Bthprops API.</summary>
public static class WindowsBluetoothStatus
{
    public static BluetoothResult Read()
    {
        var radios = new List<BluetoothRadio>();
        var parameters = new BluetoothFindRadioParams { DwSize = Marshal.SizeOf<BluetoothFindRadioParams>() };
        var findHandle = BluetoothFindFirstRadio(ref parameters, out var radioHandle);
        if (findHandle == IntPtr.Zero) return new BluetoothResult(false, radios);

        try
        {
            AddRadio(radios, radioHandle);
            radioHandle = IntPtr.Zero;
            while (true)
            {
                radioHandle = IntPtr.Zero;
                if (!BluetoothFindNextRadio(findHandle, out radioHandle)) break;
                AddRadio(radios, radioHandle);
                radioHandle = IntPtr.Zero;
            }
        }
        finally
        {
            if (radioHandle != IntPtr.Zero) CloseHandle(radioHandle);
            BluetoothFindRadioClose(findHandle);
        }

        return new BluetoothResult(radios.Count > 0, radios);
    }

    private static void AddRadio(List<BluetoothRadio> radios, IntPtr radioHandle)
    {
        try
        {
            var info = new BluetoothRadioInfo { DwSize = Marshal.SizeOf<BluetoothRadioInfo>() };
            if (BluetoothGetRadioInfo(radioHandle, ref info) != 0) return;
            radios.Add(new BluetoothRadio(info.SzName.TrimEnd('\0'), FormatAddress(info.Address)));
        }
        finally
        {
            if (radioHandle != IntPtr.Zero) CloseHandle(radioHandle);
        }
    }

    private static string FormatAddress(ulong address) => string.Join(":", Enumerable.Range(0, 6)
        .Select(index => ((address >> ((5 - index) * 8)) & 0xff).ToString("X2")));

    [StructLayout(LayoutKind.Sequential)]
    private struct BluetoothFindRadioParams { public int DwSize; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct BluetoothRadioInfo
    {
        public int DwSize;
        public ulong Address;
        public uint UlClassofDevice;
        public ushort LmpSubversion;
        public ushort Manufacturer;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 248)] public string SzName;
    }

    [DllImport("bthprops.cpl", SetLastError = true)]
    private static extern IntPtr BluetoothFindFirstRadio(ref BluetoothFindRadioParams parameters, out IntPtr radioHandle);
    [DllImport("bthprops.cpl", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool BluetoothFindNextRadio(IntPtr findHandle, out IntPtr radioHandle);
    [DllImport("bthprops.cpl")]
    private static extern bool BluetoothFindRadioClose(IntPtr findHandle);
    [DllImport("bthprops.cpl")]
    private static extern uint BluetoothGetRadioInfo(IntPtr radioHandle, ref BluetoothRadioInfo radioInfo);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
}
