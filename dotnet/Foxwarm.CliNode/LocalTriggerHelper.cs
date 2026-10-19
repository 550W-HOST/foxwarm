using System.Net;
using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.CliNode;

internal static class LocalTriggerHelper
{
    internal static async Task<int?> TryRun(string[] args)
    {
        if (args.Length == 0 || args[0] != "--local-trigger-helper")
            return null;
        try
        {
            if (args.Length < 5)
                throw new InvalidDataException("Usage: trigger-session-event.sh <session-id> <message> [event-type]");
            var meta = (JsonObject)JsonNode.Parse(await File.ReadAllTextAsync(args[1]))!;
            var token = NodePaths.TrimSpace(await File.ReadAllTextAsync(args[2]));
            var address = new UriBuilder("http", NodeFileTools.Text(meta["host"])!, meta["port"]!.GetValue<int>(), "/trigger").Uri;
            using var client = new HttpClient(new HttpClientHandler { UseProxy = false }) { Timeout = Timeout.InfiniteTimeSpan };
            using var request = new HttpRequestMessage(HttpMethod.Post, address);
            request.Headers.TryAddWithoutValidation("Authorization", "Bearer " + token);
            request.Content = new StringContent(new JsonObject
            {
                ["sessionId"] = args[3],
                ["message"] = args[4],
                ["eventType"] = args.Length > 5 && args[5].Length > 0 ? args[5] : "trigger",
            }.ToJsonString(), Encoding.UTF8, "application/json");
            using var response = await client.SendAsync(request);
            if (!response.IsSuccessStatusCode)
                throw new IOException("HTTP Error " + (int)response.StatusCode + ": " + response.ReasonPhrase);
            Console.Write(await response.Content.ReadAsStringAsync());
            return 0;
        }
        catch (Exception error)
        {
            // Never include request headers or the token in helper failures.
            Console.Error.WriteLine(error is IOException or InvalidDataException ? error.Message : "Local trigger failed: " + error.GetType().Name);
            return 1;
        }
    }
}
