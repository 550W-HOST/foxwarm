using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

internal sealed class ClaudeRuntimeFixture : IAsyncDisposable
{
    internal readonly TempDirectory Temp = new();
    internal InboundMcpFixture Main = null!;
    internal SessionOwner Owner = null!;
    internal string Cwd => Path.Combine(Temp.Path, "cli");
    private string? previousConfig;
    private bool configured;

    internal static async Task<ClaudeRuntimeFixture> CreateAsync(JsonObject? peer = null, bool handoffConfirmation = false)
    {
        var f = new ClaudeRuntimeFixture();
        try
        {
            Directory.CreateDirectory(f.Cwd);
            f.previousConfig = Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR");
            // The assembly serializes tests. Only this controlled child sees this owned synthetic account directory.
            Environment.SetEnvironmentVariable(
                "CLAUDE_CONFIG_DIR",
                Path.Combine(f.Temp.Path, "cli-config")
            );
            f.configured = true;
            var root =
                Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")
                ?? throw new InvalidOperationException(
                    "FOXWARM_TS_ROOT is required for the controlled peer and installed MCP SDK."
                );
            var launcher = Path.Combine(f.Temp.Path, "claude-peer");
            await File.WriteAllTextAsync(
                launcher,
                "#!/bin/sh\nexec node '"
                    + root.Replace("'", "'\\''")
                    + "/dotnet/Foxwarm.Tests/Mcp/Fixtures/claude-runtime-peer.mjs' \"$@\"\n"
            );
            if (!OperatingSystem.IsLinux())
                throw new PlatformNotSupportedException();
            File.SetUnixFileMode(
                launcher,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            );
            await f.PeerAsync(peer ?? new JsonObject());
            var app = InboundMcpFixture.App();
            app["handoffConfirmation"] = handoffConfirmation;
            app["claudeCode"] = new JsonObject
            {
                ["executable"] = launcher,
                ["workingDirectory"] = f.Cwd,
                ["credentialLifetimeSeconds"] = 1,
            };
            f.Main = await InboundMcpFixture.CreateAsync(appConfiguration: app);
            var agentMemory = Path.Combine(f.Main.Manager.AgentDirectory("main"), "memory");
            Directory.CreateDirectory(agentMemory);
            await File.WriteAllTextAsync(
                Path.Combine(agentMemory, "RULES.md"),
                "Owned runtime instruction.\n"
            );
            f.Owner = await f.Main.Manager.CreateNamedAsync(
                "main",
                "external",
                null,
                null,
                runtime: "claude-code"
            );
            f.Owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            return f;
        }
        catch
        {
            await f.DisposeAsync();
            throw;
        }
    }

    internal Task PeerAsync(JsonObject settings) =>
        File.WriteAllTextAsync(Path.Combine(Cwd, "peer.json"), settings.ToJsonString());

    internal async Task RunAsync(string? text = "input")
    {
        if (text is not null)
            await Owner.Registry.Ingress.EnqueueAsync(Owner.Id, QueueItem.UserText(text));
        await Owner.Registry.Runner.ProcessQueueAsync(Owner.Id).WaitAsync(TimeSpan.FromSeconds(30));
    }

    internal JsonObject[] Lines(string name) =>
        File.ReadAllLines(Path.Combine(Cwd, name))
            .Select(line => JsonNode.Parse(line)!.AsObject())
            .ToArray();

    internal Task ReadyAsync() => WaitForFileAsync("ready");

    internal async Task WaitForFileAsync(string name, CancellationToken token = default)
    {
        var file = Path.Combine(Cwd, name);
        var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var watcher = new FileSystemWatcher(Cwd, name) { EnableRaisingEvents = true };
        watcher.Created += (_, _) => ready.TrySetResult();
        watcher.Changed += (_, _) => ready.TrySetResult();
        if (File.Exists(file))
            return;
        await ready.Task.WaitAsync(TimeSpan.FromSeconds(20), token);
    }

    public async ValueTask DisposeAsync()
    {
        if (Main is not null)
            await Main.DisposeAsync();
        if (configured)
            Environment.SetEnvironmentVariable("CLAUDE_CONFIG_DIR", previousConfig);
        Temp.Dispose();
    }
}
