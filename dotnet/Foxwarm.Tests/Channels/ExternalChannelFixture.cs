using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

internal sealed class ExternalChannelFixture : IAsyncDisposable
{
    internal readonly TempDirectory Temp = new();
    internal string Data => Path.Combine(Temp.Path, "data");
    internal string Work => Path.Combine(Temp.Path, "work");
    internal ModelConfiguration Configuration = null!;
    internal SessionManager Manager = null!;
    internal MessageRouter Router = null!;
    internal SessionOwner Owner = null!;
    internal ToolRegistry Registry = null!;

    internal static JsonObject Channel(string token = "a") =>
        new()
        {
            ["type"] = "telegram",
            ["botToken"] = token,
            ["allowedUsers"] = new JsonArray("11"),
        };

    internal static async Task<ExternalChannelFixture> CreateAsync(
        JsonObject? channels = null,
        Uri? provider = null,
        Foxwarm.Channels.ChannelTransportDependencies? dependencies = null
    )
    {
        var f = new ExternalChannelFixture();
        Directory.CreateDirectory(Path.Combine(f.Data, "state"));
        Directory.CreateDirectory(f.Work);
        var channelYaml = ModelConfiguration
            .ChannelsYamlForObject(channels ?? new JsonObject())
            .TrimEnd();
        await File.WriteAllTextAsync(
            Path.Combine(f.Data, "state", "config.yaml"),
            "channels:\n"
                + string.Join("\n", channelYaml.Split('\n').Select(line => "  " + line))
                + "\n"
        );
        var endpoint = provider ?? new Uri("http://127.0.0.1:1/v1/");
        await File.WriteAllTextAsync(
            Path.Combine(f.Data, "state", "models.yaml"),
            new JsonObject
            {
                ["default"] = "local/wire",
                ["providers"] = new JsonObject
                {
                    ["local"] = new JsonObject
                    {
                        ["providerType"] = "openai-responses",
                        ["baseUrl"] = endpoint.ToString(),
                        ["models"] = new JsonArray("wire"),
                    },
                },
            }.ToJsonString()
        );
        f.Configuration = new(f.Data);
        f.Manager = new(
            f.Data,
            f.Work,
            new ResponsesClientOptions(endpoint, "wire", "", "", "", 1024),
            f.Configuration.Models
        );
        await f.Manager.LoadMainHostAsync();
        f.Router = new(new SessionRuntime(f.Manager));
        f.Manager.InitializeChannels(f.Router, f.Configuration, dependencies);
        if (provider is null)
            f.Manager.TopologyChanged += () =>
            {
                foreach (var owner in f.Manager.Owners())
                    owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            };
        f.Owner = await f.Manager.CreateNamedAsync("main", "source", null, null);
        f.Owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        var definitions = WorkspaceTools.Definitions();
        foreach (
            var item in FileDeliveryDefinitions
                .Definitions()
                .Concat(UnifiedToolDefinitions.All())
                .Concat(ToolScriptToolDefinitions.Definitions())
                .Concat(MainLocalToolDefinitions.Definitions())
        )
            definitions.Add(item?.DeepClone());
        definitions.Add(ToolAuthorizationToolDefinition.Definition());
        f.Registry = SessionToolExecutor.CreateRegistry(
            definitions,
            f.Manager.OutboundMcp,
            owner => f.Manager.IdentityWorkspace(owner).ToolDirectory,
            f.Manager.Nodes
        );
        return f;
    }

    internal async Task<JsonNode?> ToolAsync(
        string name,
        JsonObject args,
        SessionOwner? owner = null
    )
    {
        owner ??= Owner;
        var tools = new SessionToolExecutor(
            new WorkspaceTools(Manager.IdentityWorkspace(owner).ToolDirectory),
            owner,
            Manager,
            Registry
        );
        tools.BeginTurn();
        return await tools.ExecuteAsync(
            new JsonObject
            {
                ["id"] = Guid.NewGuid().ToString("N"),
                ["name"] = name,
                ["args"] = args.DeepClone(),
            },
            default
        );
    }

    public async ValueTask DisposeAsync()
    {
        Manager.BeginShutdown();
        await Manager.ManagedChannels!.DisposeAsync();
        await Manager.ShutdownAsync();
        await Manager.DisposeAsync();
        Temp.Dispose();
    }
}
