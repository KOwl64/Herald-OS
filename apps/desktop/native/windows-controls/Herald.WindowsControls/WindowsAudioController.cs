using System.Runtime.InteropServices;

namespace Herald.WindowsControls;

/// <summary>
/// Documented MMDevice/Core Audio implementation for endpoint status, volume and mute. Choosing a
/// system default endpoint is deliberately excluded: Windows exposes no supported public API for it.
/// </summary>
public sealed class WindowsAudioController : IAudioController
{
    private const uint ClsctxInprocServer = 0x1;
    private const uint DeviceStateActive = 0x1;
    private const uint StgmRead = 0;
    private const uint CoinitMultithreaded = 0;
    private const int RpcEChangedMode = unchecked((int)0x80010106);
    private static readonly Guid ClsidMmDeviceEnumerator = new("BCDE0395-E52F-467C-8E3D-C4579291692E");
    private static readonly Guid IidMmDeviceEnumerator = new("A95664D2-9614-4F35-A746-DE8DB63617E6");
    private static readonly Guid IidAudioEndpointVolume = new("5CDF2C82-841E-4546-9722-0CF74078229A");
    private static readonly PropertyKey DeviceFriendlyName = new(new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), 14);

    public AudioResult ReadStatus() => InComApartment(enumerator => new AudioResult(
        true,
        ReadEndpoints(enumerator, EDataFlow.Render),
        ReadEndpoints(enumerator, EDataFlow.Capture)));

    public void SetVolume(string? id, int? percent, bool? muted) => InComApartment(enumerator =>
    {
        var device = string.IsNullOrWhiteSpace(id) ? DefaultDevice(enumerator, EDataFlow.Render) : DeviceById(enumerator, id);
        try
        {
            var volume = ActivateVolume(device);
            try
            {
                if (percent is int level) Check(volume.SetMasterVolumeLevelScalar(level / 100f, IntPtr.Zero));
                if (muted is bool value) Check(volume.SetMute(value, IntPtr.Zero));
            }
            finally { Release(volume); }
        }
        finally { Release(device); }
        return 0;
    });

    private static IReadOnlyList<AudioDeviceResult> ReadEndpoints(IMMDeviceEnumerator enumerator, EDataFlow flow)
    {
        var defaultId = TryGetDefaultId(enumerator, flow);
        Check(enumerator.EnumAudioEndpoints(flow, DeviceStateActive, out var devices));
        try
        {
            Check(devices.GetCount(out var count));
            var results = new List<AudioDeviceResult>(checked((int)count));
            for (uint index = 0; index < count; index++)
            {
                Check(devices.Item(index, out var device));
                try
                {
                    var id = GetId(device);
                    var volume = ActivateVolume(device);
                    try
                    {
                        Check(volume.GetMasterVolumeLevelScalar(out var scalar));
                        Check(volume.GetMute(out var muted));
                        results.Add(new AudioDeviceResult(id, FriendlyName(device) ?? id, id == defaultId, ToPercent(scalar), muted));
                    }
                    finally { Release(volume); }
                }
                finally { Release(device); }
            }
            return results;
        }
        finally { Release(devices); }
    }

    private static string? TryGetDefaultId(IMMDeviceEnumerator enumerator, EDataFlow flow)
    {
        var hr = enumerator.GetDefaultAudioEndpoint(flow, ERole.Console, out var device);
        if (hr < 0) return null; // A VM/desktop may have no endpoint for one flow.
        try { return GetId(device); }
        finally { Release(device); }
    }

    private static IMMDevice DefaultDevice(IMMDeviceEnumerator enumerator, EDataFlow flow)
    {
        Check(enumerator.GetDefaultAudioEndpoint(flow, ERole.Console, out var device));
        return device;
    }

    private static IMMDevice DeviceById(IMMDeviceEnumerator enumerator, string id)
    {
        Check(enumerator.GetDevice(id, out var device));
        return device;
    }

    private static IAudioEndpointVolume ActivateVolume(IMMDevice device)
    {
        var iid = IidAudioEndpointVolume;
        Check(device.Activate(ref iid, ClsctxInprocServer, IntPtr.Zero, out var volume));
        return volume;
    }

    private static string GetId(IMMDevice device)
    {
        Check(device.GetId(out var value));
        try { return Marshal.PtrToStringUni(value) ?? throw new InvalidOperationException("Audio endpoint did not return an ID."); }
        finally { Marshal.FreeCoTaskMem(value); }
    }

    private static string? FriendlyName(IMMDevice device)
    {
        Check(device.OpenPropertyStore(StgmRead, out var store));
        try
        {
            var key = DeviceFriendlyName;
            Check(store.GetValue(ref key, out var value));
            try { return value.StringValue(); }
            finally { value.Dispose(); }
        }
        finally { Release(store); }
    }

    private static int ToPercent(float scalar) => Math.Clamp((int)MathF.Round(scalar * 100), 0, 100);

    private static T InComApartment<T>(Func<IMMDeviceEnumerator, T> action)
    {
        var initialized = CoInitializeEx(IntPtr.Zero, CoinitMultithreaded);
        if (initialized < 0 && initialized != RpcEChangedMode) Check(initialized);
        try
        {
            var clsid = ClsidMmDeviceEnumerator;
            var iid = IidMmDeviceEnumerator;
            Check(CoCreateInstance(ref clsid, IntPtr.Zero, ClsctxInprocServer, ref iid, out IMMDeviceEnumerator enumerator));
            try { return action(enumerator); }
            finally { Release(enumerator); }
        }
        finally
        {
            if (initialized >= 0) CoUninitialize();
        }
    }

    private static void Check(int hresult)
    {
        if (hresult < 0) Marshal.ThrowExceptionForHR(hresult);
    }

    private static void Release(object? value)
    {
        if (value is not null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value);
    }

    [DllImport("ole32.dll")] private static extern int CoInitializeEx(IntPtr reserved, uint coInit);
    [DllImport("ole32.dll")] private static extern void CoUninitialize();
    [DllImport("ole32.dll")] private static extern int CoCreateInstance(ref Guid clsid, IntPtr outer, uint context, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IMMDeviceEnumerator value);
    [DllImport("ole32.dll")] private static extern int PropVariantClear(ref PropVariant value);

    private enum EDataFlow { Render, Capture, All }
    private enum ERole { Console, Multimedia, Communications }

    [StructLayout(LayoutKind.Sequential)]
    private readonly struct PropertyKey(Guid formatId, uint propertyId)
    {
        public readonly Guid FormatId = formatId;
        public readonly uint PropertyId = propertyId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropVariant
    {
        private readonly ushort vt;
        private readonly ushort reserved1;
        private readonly ushort reserved2;
        private readonly ushort reserved3;
        private readonly IntPtr pointer;

        public string? StringValue() => vt switch
        {
            31 => Marshal.PtrToStringUni(pointer), // VT_LPWSTR
            8 => Marshal.PtrToStringBSTR(pointer), // VT_BSTR
            _ => null
        };

        public void Dispose() => _ = PropVariantClear(ref this);
    }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(EDataFlow flow, uint stateMask, [MarshalAs(UnmanagedType.Interface)] out IMMDeviceCollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow flow, ERole role, [MarshalAs(UnmanagedType.Interface)] out IMMDevice device);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, [MarshalAs(UnmanagedType.Interface)] out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-C0A0BB872B1E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int Item(uint index, [MarshalAs(UnmanagedType.Interface)] out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr activationParameters, [MarshalAs(UnmanagedType.Interface)] out IAudioEndpointVolume value);
        [PreserveSig] int OpenPropertyStore(uint access, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);
        [PreserveSig] int GetId(out IntPtr id);
        [PreserveSig] int GetState(out uint state);
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig] int Commit();
    }

    // Declaration order is ABI-significant and mirrors endpointvolume.h.
    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioEndpointVolume
    {
        [PreserveSig] int RegisterControlChangeNotify(IntPtr callback);
        [PreserveSig] int UnregisterControlChangeNotify(IntPtr callback);
        [PreserveSig] int GetChannelCount(out uint count);
        [PreserveSig] int SetMasterVolumeLevel(float levelDb, IntPtr eventContext);
        [PreserveSig] int SetMasterVolumeLevelScalar(float level, IntPtr eventContext);
        [PreserveSig] int GetMasterVolumeLevel(out float levelDb);
        [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
        [PreserveSig] int SetChannelVolumeLevel(uint channel, float levelDb, IntPtr eventContext);
        [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, IntPtr eventContext);
        [PreserveSig] int GetChannelVolumeLevel(uint channel, out float levelDb);
        [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, IntPtr eventContext);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
        [PreserveSig] int GetVolumeStepInfo(out uint step, out uint stepCount);
        [PreserveSig] int VolumeStepUp(IntPtr eventContext);
        [PreserveSig] int VolumeStepDown(IntPtr eventContext);
        [PreserveSig] int QueryHardwareSupport(out uint hardwareSupportMask);
    }
}
