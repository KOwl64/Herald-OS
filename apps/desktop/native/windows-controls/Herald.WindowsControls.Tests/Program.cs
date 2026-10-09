using Herald.WindowsControls;

var tests = new (string Name, Action Run)[]
{
    ("dispatches battery.status", DispatchesBattery),
    ("rejects empty verb", RejectsEmptyVerb),
    ("rejects unknown verbs", RejectsUnknownVerb),
    ("reports unimplemented status verbs honestly", ReportsUnsupportedVerb)
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
static void ReportsUnsupportedVerb()
{
    var response = Protocol.Dispatch(new Request(Protocol.AudioStatusVerb), ThrowingBattery);
    Assert(!response.Ok && response.Error?.Code == "not_supported", "Unimplemented controls must not report success.");
}
static BatteryResult ThrowingBattery() => throw new InvalidOperationException("Must not be called.");
static void Assert(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
