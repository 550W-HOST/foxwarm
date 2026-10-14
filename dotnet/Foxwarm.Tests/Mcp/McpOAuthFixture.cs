using System.Diagnostics;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.WebUtilities;

namespace Foxwarm.Tests;

internal sealed class McpOAuthPeer : IAsyncDisposable
{
    private readonly Process process;
    private readonly Task<string> errors;
    private readonly HttpClient http = new(new HttpClientHandler { AllowAutoRedirect = false });
    internal string Url { get; }
    internal string Resource => Url + "/mcp";
    private McpOAuthPeer(Process process, Task<string> errors, string url)
    { this.process = process; this.errors = errors; Url = url; }

    internal static async Task<McpOAuthPeer> StartAsync()
    {
        var start = new ProcessStartInfo("node") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        start.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory, "Mcp", "Fixtures", "oauth-peer.mjs"));
        var process = Process.Start(start)!;
        var errors = process.StandardError.ReadToEndAsync();
        var line = await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(15));
        if (line is null) throw new IOException(await errors);
        return new(process, errors, JsonNode.Parse(line)!["url"]!.GetValue<string>());
    }

    internal async Task<JsonObject> StateAsync() => (await http.GetFromJsonAsync<JsonObject>(Url + "/fixture/state"))!;
    internal async Task SetAsync(JsonObject values)
    { using var response = await http.PostAsJsonAsync(Url + "/fixture/state", values); response.EnsureSuccessStatusCode(); }
    internal async Task MetadataAsync(JsonObject value)
    { using var response = await http.PostAsJsonAsync(Url + "/fixture/client-metadata", value); response.EnsureSuccessStatusCode(); }
    internal async Task GateAsync(string kind)
    { using var response = await http.PostAsJsonAsync(Url + "/fixture/gate/" + kind, new { }); response.EnsureSuccessStatusCode(); }
    internal async Task ReleaseAsync(string kind)
    { using var response = await http.PostAsJsonAsync(Url + "/fixture/release/" + kind, new { }); response.EnsureSuccessStatusCode(); }
    internal async Task WaitAsync(string field)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while ((await StateAsync())[field]?.GetValue<bool>() != true)
            await Task.Delay(20, deadline.Token);
    }
    internal async Task<JsonObject> CallbackAsync(string authorizationUrl)
    {
        using var response = await http.GetAsync(authorizationUrl);
        if (response.Headers.Location is not { } location) throw new IOException(await response.Content.ReadAsStringAsync());
        return new JsonObject(QueryHelpers.ParseQuery(location.Query)
            .Select(pair => new KeyValuePair<string, JsonNode?>(pair.Key, JsonValue.Create(pair.Value.ToString()))));
    }

    internal async Task AuthorizeAsync(McpClient client, string name = "peer")
    {
        var url = await client.OAuth.BeginAsync(name, client.AuthorizationServer(name), default);
        await client.OAuth.FinishAsync(await CallbackAsync(url), default);
    }

    internal static JsonObject Value(JsonNode? response)
    {
        if (response is JsonObject obj && obj["context"] is not null) return obj;
        if (response?["content"] is JsonArray blocks)
            return JsonNode.Parse(blocks[0]!["text"]!.GetValue<string>())!.AsObject();
        throw new InvalidDataException(response?.ToJsonString() ?? "Missing peer result");
    }

    private bool disposed;
    public async ValueTask DisposeAsync()
    {
        if (disposed) return;
        disposed = true;
        http.Dispose();
        if (!process.HasExited) process.Kill(true);
        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(15));
        _ = await errors;
        process.Dispose();
    }
}
