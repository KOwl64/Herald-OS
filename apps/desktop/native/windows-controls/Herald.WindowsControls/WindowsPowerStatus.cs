using System.Runtime.InteropServices;

namespace Herald.WindowsControls;

/// <summary>Reads battery state directly from the documented Kernel32 API.</summary>
public static class WindowsPowerStatus
{
    private const byte UnknownByte = 255;
    private const byte NoSystemBattery = 128;
    private const byte Charging = 8;
    private const uint UnknownTime = uint.MaxValue;

    public static BatteryResult Read()
    {
        if (!GetSystemPowerStatus(out var status)) throw new InvalidOperationException("GetSystemPowerStatus failed.");
        var present = (status.BatteryFlag & NoSystemBattery) == 0;
        return new BatteryResult(
            present,
            present && status.BatteryLifePercent != UnknownByte ? status.BatteryLifePercent : null,
            present && (status.BatteryFlag & Charging) != 0,
            status.ACLineStatus switch { 0 => "offline", 1 => "online", _ => "unknown" },
            present && status.BatteryLifeTime != UnknownTime ? status.BatteryLifeTime : null,
            present && status.BatteryFullLifeTime != UnknownTime ? status.BatteryFullLifeTime : null);
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetSystemPowerStatus(out SystemPowerStatus systemPowerStatus);

    [StructLayout(LayoutKind.Sequential)]
    private struct SystemPowerStatus
    {
        public byte ACLineStatus;
        public byte BatteryFlag;
        public byte BatteryLifePercent;
        public byte SystemStatusFlag;
        public uint BatteryLifeTime;
        public uint BatteryFullLifeTime;
    }
}
