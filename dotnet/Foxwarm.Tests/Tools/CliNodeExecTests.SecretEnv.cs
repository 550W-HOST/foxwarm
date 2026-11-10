using System.Diagnostics;
using System.Text.Json.Nodes;
using Foxwarm.CliNode;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class CliNodeExecTests
{
    [Fact]
    public async Task Secret_environment_reaches_only_the_launched_process()
    {
        using var owned = new OwnedPaths();
        const string Value = "synthetic-node-env-0808";
        var launches = new List<ProcessStartInfo>();
        await using var manager = new NodeExecManager(
            owned.Paths,
            owned.Registry,
            (_, _, _) => Task.CompletedTask
        )
        {
            Launch = start =>
            {
                launches.Add(start);
                return Environment.ProcessId;
            },
        };
        JsonObject SecretFrame(string id, string? names, string? env)
        {
            var frame = Frame(id);
            if (names is not null)
                frame["args"]!["secretEnv"] = JsonNode.Parse(names);
            if (env is not null)
                frame["env"] = JsonNode.Parse(env);
            return frame;
        }

        // Values must come from Main for exactly the variables the call names.
        foreach (
            var (names, env) in new (string?, string?)[]
            {
                ("""{"CI_TOKEN":"ci-token"}""", null),
                (null, """{"CI_TOKEN":"value"}"""),
                ("""{"CI_TOKEN":"ci-token"}""", """{"OTHER":"value"}"""),
                ("""{"FOXWARM_EXEC_LOG_PATH":"ci-token"}""", """{"FOXWARM_EXEC_LOG_PATH":"x"}"""),
                ("""{"A":"ci-token","a":"ci-token"}""", """{"A":"x","a":"y"}"""),
            }
        )
            await Assert.ThrowsAsync<InvalidDataException>(() =>
                manager.Start(
                    SecretFrame("quiet-otter", names, env),
                    "main",
                    "owned",
                    CancellationToken.None,
                    () => { }
                )
            );
        Assert.Empty(launches);

        var entry = await manager.Start(
            SecretFrame(
                "brave-lynx",
                """{"CI_TOKEN":"ci-token"}""",
                $$"""{"CI_TOKEN":"{{Value}}"}"""
            ),
            "main",
            "owned",
            CancellationToken.None,
            () => { }
        );
        var start = Assert.Single(launches);
        Assert.Equal(Value, start.Environment["CI_TOKEN"]);
        Assert.DoesNotContain(Value, entry.ToJsonString());
        // The script, paths file and running-exec registry never hold the value.
        SecretPlaintext.AssertAbsent(owned.Temp.Path, Value);
    }

    [Fact]
    public void Capabilities_offer_secret_environment_only_with_exec()
    {
        var capabilities = NodeClient.Capabilities();
        var exec = capabilities["tools"]!
            .AsArray()
            .OfType<JsonObject>()
            .SingleOrDefault(tool => tool["name"]!.GetValue<string>() == "exec");
        if (!ExecNative.Supported)
        {
            Assert.Null(exec);
            Assert.False(capabilities["features"]!.AsObject().ContainsKey("secretEnv"));
            return;
        }
        Assert.True(capabilities["features"]!["secretEnv"]!.GetValue<bool>());
        Assert.True(exec!["parameters"]!["properties"]!.AsObject().ContainsKey("secretEnv"));
    }
}
