using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class AgentRulesTreeTests
{
    // A restricted Agent that may run commands only in its own directory.
    private const string OwnDirectoryExecRules = """
        [
          {"tool":{"source":"node","name":"exec"},"path":{"allWithin":"${agent.dir}"},"action":"allow"},
          {"action":"deny"}
        ]
        """;

    [Fact]
    public async Task Exec_secret_environment_follows_policy_and_never_reaches_the_command_or_records()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await ConfigurationFixture();
        var store = f.Configuration.Secrets.Store;
        const string ProviderValue = "synthetic-provider-env-0404";
        const string RunnerValue = "synthetic-runner-env-0505";
        store.Set("provider-key", ProviderValue);
        var runner = await ChildAgent(f, "runner", rules: Rules(OwnDirectoryExecRules));
        store.Create("runner-token", RunnerValue, null, "runner");

        Task<JsonNode?> Exec(SessionOwner owner, string variable, string secret)
        {
            var directory = f.Manager.IdentityWorkspace(owner).ToolDirectory;
            Directory.CreateDirectory(directory);
            return f.ToolAsync(
                "exec",
                new JsonObject
                {
                    ["command"] = $"printf %s \"${variable}\" | sha256sum | cut -c1-64",
                    ["cwd"] = directory,
                    ["timeout"] = 30.0,
                    ["secretEnv"] = new JsonObject { [variable] = secret },
                },
                owner
            );
        }
        string Output(JsonNode? result)
        {
            Successful(result);
            return SessionWait.Text(result!["output"]) ?? "";
        }

        // Unrestricted master exec passes any stored secret.
        Assert.Contains(
            SecretPlaintext.Sha256(ProviderValue),
            Output(await Exec(f.Owner, "PROVIDER_KEY", "provider-key"))
        );

        // An Agent whose exec is limited to its directory may pass only secrets it owns.
        Assert.Contains(
            SecretPlaintext.Sha256(RunnerValue),
            Output(await Exec(runner, "RUNNER_TOKEN", "runner-token"))
        );
        var denied = await Exec(runner, "PROVIDER_KEY", "provider-key");
        Assert.Equal("tool_authorization_denied", SessionWait.Text(denied?["error"]?["type"]));
        Assert.Contains("`provider-key`", SessionWait.Text(denied?["error"]?["message"]));

        // Missing values and variables Foxwarm sets are refused before anything starts.
        var missing = await Exec(f.Owner, "CI_TOKEN", "missing-token");
        Assert.Contains("`missing-token` has no value", ErrorMessage(missing));
        var reserved = await Exec(f.Owner, "FOXWARM_EXEC_LOG_PATH", "provider-key");
        Assert.Contains("is set by Foxwarm", ErrorMessage(reserved));
        var invalid = await Exec(f.Owner, "CI_TOKEN", "Not A Name");
        Assert.Contains("Secret names use", ErrorMessage(invalid));

        // Neither value is written anywhere in plaintext: not in scripts, exec records, logs,
        // Session rows or tool records.
        SecretPlaintext.AssertAbsent(f.Temp.Path, ProviderValue);
        SecretPlaintext.AssertAbsent(f.Temp.Path, RunnerValue);
    }
}
