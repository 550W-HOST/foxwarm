using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed partial class ProviderFileConsumerTests
{
    [Fact]
    public async Task Provider_exec_receives_secret_environment_only_on_Nodes_that_offer_it()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        const string Value = "synthetic-provider-env-0909";
        const string Command = "printf %s \"$CI_TOKEN\" | sha256sum | cut -c1-64";
        f.Configuration.Secrets.Store.Set("ci-token", Value);
        Success(await f.Manager.SelectNodeAsync(f.Owner, f.Node));
        JsonObject Args() =>
            new()
            {
                ["command"] = Command,
                ["timeout"] = 30.0,
                ["secretEnv"] = new JsonObject { ["CI_TOKEN"] = "ci-token" },
            };
        async Task<JsonObject> ExecParameters()
        {
            await f.Manager.NodeProviders.ResolveAsync(f.Node, default);
            return f
                .Manager.NodeProviders.Definitions(f.Node)
                .OfType<JsonObject>()
                .Single(definition => definition["name"]!.GetValue<string>() == "exec")[
                "parameters"
            ]!["properties"]!.AsObject();
        }

        // A Node that does not declare execEnv is not offered the parameter, and a call using
        // it fails before anything starts.
        Assert.False((await ExecParameters()).ContainsKey("secretEnv"));
        var refused = await f.Call("exec", Args());
        Assert.Contains(
            "can't pass stored secrets to commands",
            refused["error"]!["message"]!.GetValue<string>()
        );
        Assert.DoesNotContain(
            await f.Requests(),
            request => request["operation"]!.GetValue<string>() == "exec-start"
        );

        await File.WriteAllTextAsync(Path.Combine(f.Target, "exec-env"), "");
        Assert.True((await ExecParameters()).ContainsKey("secretEnv"));
        var value = await f.Call("exec", Args());
        Success(value);
        Assert.Contains(SecretPlaintext.Sha256(Value), value["output"]!.GetValue<string>());
        var start = await StartRequest(f);
        Assert.Equal(Command, start["command"]!.GetValue<string>());
        Assert.Equal(
            """{"CI_TOKEN":"synthetic-provider-env-0909"}""",
            start["env"]!.ToJsonString()
        );
        // Main keeps no copy; only the adapter's own request received it.
        SecretPlaintext.AssertAbsent(f.Data, Value);
        SecretPlaintext.AssertAbsent(f.Work, Value);
    }
}
