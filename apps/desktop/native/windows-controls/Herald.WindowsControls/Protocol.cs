namespace Herald.WindowsControls;

/// <summary>One JSON-lines request. Only documented verbs and typed arguments are accepted.</summary>
public sealed record Request(string? Verb, string? Id = null, int? Percent = null, bool? Muted = null);

public sealed record Response(bool Ok, object? Result, ProtocolError? Error)
{
    public static Response Success(object result) => new(true, result, null);
    public static Response InvalidRequest(string message) => new(false, null, new ProtocolError("invalid_request", message));
    public static Response NotSupported(string verb) => new(false, null, new ProtocolError("not_supported", $"{verb} is not implemented by this Windows helper."));
    public static Response InternalError() => new(false, null, new ProtocolError("internal_error", "The Windows helper could not complete the request."));
}

public sealed record ProtocolError(string Code, string Message);

public sealed record BatteryResult(bool Present, int? Percent, bool Charging, string AcLineStatus, uint? RemainingSeconds, uint? FullChargeSeconds);
public sealed record BluetoothRadio(string Name, string Address);
public sealed record BluetoothResult(bool Available, IReadOnlyList<BluetoothRadio> Radios);
public sealed record DisplayResult(IReadOnlyList<DisplayMonitor> Monitors);
public sealed record DisplayMonitor(string DeviceName, int Left, int Top, int Width, int Height, bool Primary);
public sealed record AudioDeviceResult(string Id, string Name, bool IsDefault, int Volume, bool Muted);
public sealed record AudioResult(bool Available, IReadOnlyList<AudioDeviceResult> Outputs, IReadOnlyList<AudioDeviceResult> Inputs);

/// <summary>Small seam around Core Audio so protocol tests need no audio hardware.</summary>
public interface IAudioController
{
    AudioResult ReadStatus();
    void SetVolume(string? id, int? percent, bool? muted);
}

public static class Protocol
{
    public const string BatteryStatusVerb = "battery.status";
    public const string AudioStatusVerb = "audio.status";
    public const string AudioVolumeVerb = "audio.volume";
    public const string AudioDefaultVerb = "audio.default";
    public const string BluetoothStatusVerb = "bluetooth.status";
    public const string DisplayStatusVerb = "display.status";

    /// <summary>Dispatches a fixed allowlist; this helper is never a general command runner.</summary>
    public static Response Dispatch(
        Request request,
        Func<BatteryResult> readBattery,
        Func<BluetoothResult>? readBluetooth = null,
        Func<DisplayResult>? readDisplays = null,
        IAudioController? audio = null)
    {
        if (string.IsNullOrWhiteSpace(request.Verb)) return Response.InvalidRequest("verb is required.");
        return request.Verb switch
        {
            BatteryStatusVerb => Response.Success(readBattery()),
            BluetoothStatusVerb when readBluetooth is not null => Response.Success(readBluetooth()),
            DisplayStatusVerb when readDisplays is not null => Response.Success(readDisplays()),
            AudioStatusVerb when audio is not null => Response.Success(audio.ReadStatus()),
            AudioVolumeVerb when audio is not null && request.Percent is null && request.Muted is null => Response.InvalidRequest("audio.volume needs percent and/or muted."),
            AudioVolumeVerb when audio is not null && request.Percent is < 0 or > 100 => Response.InvalidRequest("audio volume must be between 0 and 100."),
            AudioVolumeVerb when audio is not null => SetAudioVolume(audio, request),
            // There is no documented public API to choose the Windows default audio endpoint.
            // Do not rely on the private IPolicyConfig COM contract from this helper.
            AudioDefaultVerb or AudioStatusVerb or AudioVolumeVerb or BluetoothStatusVerb or DisplayStatusVerb => Response.NotSupported(request.Verb),
            _ => Response.InvalidRequest("verb is not allowlisted.")
        };
    }

    private static Response SetAudioVolume(IAudioController audio, Request request)
    {
        audio.SetVolume(request.Id, request.Percent, request.Muted);
        return Response.Success(new { });
    }
}
