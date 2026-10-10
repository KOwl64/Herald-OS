using System.Text.Json;

namespace Herald.WindowsControls;

/// <summary>JSON-lines entry point. The helper never writes diagnostics to stdout.</summary>
internal static class Program
{
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true
    };

    public static int Main(string[] args)
    {
        string? line;
        while ((line = Console.ReadLine()) is not null)
        {
            Response response;
            try
            {
                var request = JsonSerializer.Deserialize<Request>(line, Json);
                response = request is null
                    ? Response.InvalidRequest("Request must be a JSON object.")
                    : Protocol.Dispatch(request, WindowsPowerStatus.Read, WindowsBluetoothStatus.Read, WindowsDisplayStatus.Read, new WindowsAudioController());
            }
            catch (JsonException)
            {
                response = Response.InvalidRequest("Request must be valid JSON.");
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error);
                // Do not leak paths, HRESULTs, or other host details over this public boundary.
                response = Response.InternalError();
            }

            Console.Out.WriteLine(JsonSerializer.Serialize(response, Json));
            Console.Out.Flush();
        }

        return 0;
    }
}
