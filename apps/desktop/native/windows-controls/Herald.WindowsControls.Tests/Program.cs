using Herald.WindowsControls;

var tests = new (string Name, Action Run)[]
{
    ("dispatches battery.status", DispatchesBattery),
    ("rejects empty verb", RejectsEmptyVerb),
    ("rejects unknown verbs", RejectsUnknownVerb),
    ("dispatches Bluetooth status", DispatchesBluetooth),
    ("dispatches display status", DispatchesDisplays),
    ("dispatches audio status", DispatchesAudio),
    ("changes audio volume through the fixed protocol", ChangesAudioVolume),
    ("rejects invalid audio volume requests", RejectsInvalidAudioVolume),
    ("keeps default-device switching unsupported", KeepsAudioDefaultUnsupported)
};
var failures = new List<string>();
foreach (var test in tests)
{
    try { test.Run(); Console.WriteLine($"PASS {test.Name}"); }
    catch (Exception error) { failures.Add($"FAIL {test.Name}: {error.Message}"); }
}
foreach (var failure in failures) Console.Error.WriteLine(failure);
return failures.Count == 0 ? 0 : 1;

static void DispatchesBattery()
{
    var expected = new BatteryResult(true, 73, true, "online", 1200, 1800);
    var response = Protocol.Dispatch(new Request(Protocol.BatteryStatusVerb), () => expected);
    Assert(response.Ok && Equals(response.Result, expected) && response.Error is null, "Battery result was not returned.");
}
static void RejectsEmptyVerb()
{
    var response = Protocol.Dispatch(new Request(" "), ThrowingBattery);
    Assert(!response.Ok && response.Error?.Code == "invalid_request", "Empty verb should be invalid.");
}
static void RejectsUnknownVerb()
{
    var response = Protocol.Dispatch(new Request("powershell.exec"), ThrowingBattery);
    Assert(!response.Ok && response.Error?.Code == "invalid_request", "Non-allowlisted verb should be rejected.");
}
static void DispatchesBluetooth()
{
    var expected = new BluetoothResult(true, [new BluetoothRadio("Intel Wireless Bluetooth", "00:11:22:33:44:55")]);
    var response = Protocol.Dispatch(new Request(Protocol.BluetoothStatusVerb), ThrowingBattery, () => expected);
    Assert(response.Ok && Equals(response.Result, expected), "Bluetooth result was not returned.");
}
static void DispatchesDisplays()
{
    var expected = new DisplayResult([new DisplayMonitor("\\\\.\\DISPLAY1", 0, 0, 1920, 1080, true)]);
    var response = Protocol.Dispatch(new Request(Protocol.DisplayStatusVerb), ThrowingBattery, null, () => expected);
    Assert(response.Ok && Equals(response.Result, expected), "Display result was not returned.");
}
static void DispatchesAudio()
{
    var controller = new FakeAudioController();
    var response = Protocol.Dispatch(new Request(Protocol.AudioStatusVerb), ThrowingBattery, null, null, controller);
    Assert(response.Ok && Equals(response.Result, controller.Status), "Audio result was not returned.");
}
static void ChangesAudioVolume()
{
    var controller = new FakeAudioController();
    var response = Protocol.Dispatch(new Request(Protocol.AudioVolumeVerb, "render-1", 61, true), ThrowingBattery, null, null, controller);
    Assert(response.Ok, "Audio volume request was not accepted.");
    Assert(controller.LastId == "render-1" && controller.LastPercent == 61 && controller.LastMuted == true, "Audio controller did not receive typed volume arguments.");
}
static void RejectsInvalidAudioVolume()
{
    var controller = new FakeAudioController();
    var missing = Protocol.Dispatch(new Request(Protocol.AudioVolumeVerb), ThrowingBattery, null, null, controller);
    var outOfRange = Protocol.Dispatch(new Request(Protocol.AudioVolumeVerb, Percent: 101), ThrowingBattery, null, null, controller);
    Assert(!missing.Ok && missing.Error?.Code == "invalid_request", "A volume action without a change should fail.");
    Assert(!outOfRange.Ok && outOfRange.Error?.Code == "invalid_request", "Out-of-range volume should fail.");
    Assert(controller.LastPercent is null && controller.LastMuted is null, "Invalid requests must not call audio controls.");
}
static void KeepsAudioDefaultUnsupported()
{
    var response = Protocol.Dispatch(new Request(Protocol.AudioDefaultVerb), ThrowingBattery, null, null, new FakeAudioController());
    Assert(!response.Ok && response.Error?.Code == "not_supported", "Default-device switching must stay explicit and unsupported.");
}
static BatteryResult ThrowingBattery() => throw new InvalidOperationException("Must not be called.");
static void Assert(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }

sealed class FakeAudioController : IAudioController
{
    public AudioResult Status { get; } = new(true, [new AudioDeviceResult("render-1", "Speakers", true, 42, false)], []);
    public string? LastId { get; private set; }
    public int? LastPercent { get; private set; }
    public bool? LastMuted { get; private set; }
    public AudioResult ReadStatus() => Status;
    public void SetVolume(string? id, int? percent, bool? muted) => (LastId, LastPercent, LastMuted) = (id, percent, muted);
}
