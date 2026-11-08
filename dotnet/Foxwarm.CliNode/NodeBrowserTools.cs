using System.Text.Json.Nodes;

namespace Foxwarm.CliNode;

// This Node's browser_* tools: the shared JavaScript host run as a child process on this
// machine, started on first use. Session policy and image registration stay in Main.
internal sealed class NodeBrowserTools(BrowserHost? host = null) : IAsyncDisposable
{
    private readonly BrowserHost host = host ?? new(BrowserHost.DefaultBundlePath());

    // Advertised only when this machine can run them, so a Node without node or a browser
    // never offers tools that cannot work.
    internal JsonArray Definitions()
    {
        var description = host.Describe();
        return description.Available ? (JsonArray)description.Tools.DeepClone() : new JsonArray();
    }

    internal async Task<JsonNode> Execute(
        string tool,
        JsonObject? args,
        CancellationToken token
    ) => await host.CallAsync(tool, args ?? new JsonObject(), token) ?? new JsonObject();

    public ValueTask DisposeAsync() => host.DisposeAsync();
}
