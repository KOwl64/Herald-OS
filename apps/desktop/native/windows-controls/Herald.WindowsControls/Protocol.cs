namespace Herald.WindowsControls;

/// <summary>One JSON-lines request. Only documented status verbs are accepted.</summary>
public sealed record Request(string? Verb);

public sealed record Response(bool Ok, object? Result, ProtocolError? Error)
{
    public static Response Success(object result) => new(true, result, null);
    public static Response InvalidRequest(string message) => new(false, null, new ProtocolError("invalid_request", message));
    public static Response NotSupported(string verb) => new(false, null, new ProtocolError("not_supported", $"{verb} is not implemented by this Windows helper."));
    public static Response InternalError() => new(false, null, new ProtocolError("internal_error", "The Windows helper could not complete the request."));
}

public sealed record ProtocolError(string Code, string Message);

public sealed record BatteryResult(bool Present, int? Percent, bool Charging, string AcLineStatus, uint? RemainingSeconds, uint? FullChargeSeconds);

public static class Protocol
{
    public const string BatteryStatusVerb = "battery.status";
    public const string AudioStatusVerb = "audio.status";
    public const string BluetoothStatusVerb = "bluetooth.status";
    public const string DisplayStatusVerb = "display.status";

    /// <summary>Dispatches a fixed allowlist; this helper is never a general command runner.</summary>
    public static Response Dispatch(Request request, Func<BatteryResult> readBattery)
    {
        if (string.IsNullOrWhiteSpace(request.Verb)) return Response.InvalidRequest("verb is required.");
        return request.Verb switch
        {
            BatteryStatusVerb => Response.Success(readBattery()),
            AudioStatusVerb or BluetoothStatusVerb or DisplayStatusVerb => Response.NotSupported(request.Verb),
            _ => Response.InvalidRequest("verb is not allowlisted.")
        };
    }
}
