using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

// The master Node's browser_* tools. The browser itself is the shared JavaScript host, run as a
// child process; this class only forwards validated tool calls to it. One host (one browser, one
// default context) serves every Session on this Main process.
internal sealed class MainBrowserTools(BrowserHost? host = null) : IAsyncDisposable
{
    private readonly BrowserHost host = host ?? new(BrowserHost.DefaultBundlePath());

    internal bool Available => host.Describe().Available;

    internal Task<JsonNode?> Execute(string tool, JsonObject args, CancellationToken token) =>
        host.CallAsync(tool, args, token);

    public ValueTask DisposeAsync() => host.DisposeAsync();
}
