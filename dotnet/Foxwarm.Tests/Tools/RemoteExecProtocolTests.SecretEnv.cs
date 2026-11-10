using System.Text.Json.Nodes;
using Foxwarm.Nodes;

namespace Foxwarm.Tests;

public sealed partial class RemoteExecProtocolTests
{
    private const string RemoteSecretValue = "synthetic-remote-env-0707";

    private static JsonObject SecretExecArgs() =>
        new()
        {
            ["command"] = "owned-effect",
            ["secretEnv"] = new JsonObject { ["CI_TOKEN"] = "ci-token" },
        };

    private static Task<JsonNode?> SecretExec(Fixture fixture) =>
        fixture.Manager.Nodes.ExecuteAsync(
            "remote",
            "exec",
            SecretExecArgs(),
            fixture.Owner.Id,
            fixture.Owner.Agent,
            "remote",
            null,
            false,
            default,
            fixture.Owner
        );

    [Fact]
    public async Task Secret_environment_is_sent_only_to_Nodes_that_apply_it_to_the_process()
    {
        var resolved = 0;
        IReadOnlyDictionary<string, string>? Resolve(JsonObject args)
        {
            resolved++;
            return new Dictionary<string, string> { ["CI_TOKEN"] = RemoteSecretValue };
        }

        // A Node without the feature is refused before anything is resolved or sent.
        await using (var legacy = new Fixture())
        {
            await legacy.Start();
            legacy.Manager.Nodes.SecretEnvironment = Resolve;
            var refused = await Assert.ThrowsAsync<InvalidDataException>(() => SecretExec(legacy));
            Assert.Contains("cannot pass stored secrets", refused.Message);
            Assert.Equal(0, resolved);
            var plain = legacy.Exec();
            var first = await legacy.Read();
            Assert.Equal("owned-effect", first["args"]!["command"]!.GetValue<string>());
            Assert.False(first.ContainsKey("env"));
            await legacy.Respond(first, new JsonObject { ["output"] = "done" });
            await plain;
        }

        await using var fixture = new Fixture();
        await fixture.Start(secretEnv: true);
        fixture.Manager.Nodes.SecretEnvironment = Resolve;
        var execution = SecretExec(fixture);
        var request = await fixture.Read();
        Assert.Equal(1, resolved);
        Assert.Equal("""{"CI_TOKEN":"ci-token"}""", request["args"]!["secretEnv"]!.ToJsonString());
        Assert.Equal($$"""{"CI_TOKEN":"{{RemoteSecretValue}}"}""", request["env"]!.ToJsonString());
        await fixture.Respond(request, new JsonObject { ["output"] = "done" });
        await execution;
        SecretPlaintext.AssertAbsent(fixture.Data, RemoteSecretValue);
    }
}
