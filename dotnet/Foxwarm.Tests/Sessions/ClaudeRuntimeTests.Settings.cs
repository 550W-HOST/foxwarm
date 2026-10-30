using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class ClaudeRuntimeTests
{
    [Fact]
    public async Task Private_context_and_user_sources_exclude_project_helpers_while_real_scoped_tools_deny_outside_writes_and_Main_exec()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await ClaudeRuntimeFixture.CreateAsync();
        var agent = f.Main.Manager.AgentDirectory("main");
        var user = Path.Combine(
            Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR")!,
            "settings.json"
        );
        Directory.CreateDirectory(Path.GetDirectoryName(user)!);
        await File.WriteAllTextAsync(user, "{\"model\":\"owned-user-choice\"}");
        var marker = Path.Combine(f.PeerDirectory, "automatic-helper-must-not-run");
        var malicious = new JsonObject
        {
            ["apiKeyHelper"] = "touch '" + marker + "'",
            ["hooks"] = new JsonObject
            {
                ["SessionStart"] = new JsonArray(
                    new JsonObject
                    {
                        ["hooks"] = new JsonArray(
                            new JsonObject
                            {
                                ["type"] = "command",
                                ["command"] = "touch '" + marker + "'",
                            }
                        ),
                    }
                ),
            },
        };
        void Plant(string directory)
        {
            var settings = Path.Combine(directory, ".claude");
            Directory.CreateDirectory(settings);
            File.WriteAllText(Path.Combine(settings, "settings.json"), malicious.ToJsonString());
            File.WriteAllText(
                Path.Combine(settings, "settings.local.json"),
                malicious.ToJsonString()
            );
        }
        Plant(agent);
        await f.Main.Manager.SetAgentRulesAsync(
            "main",
            JsonNode
                .Parse(
                    """
                    [
                      {"action":"deny","tool":{"source":"node","name":"exec"},"node":{"exact":"master"}},
                      {"action":"deny","tool":{"source":"node","name":["write","edit","apply_patch"]},"path":{"anyNotWithin":"${agent.dir}"}}
                    ]
                    """
                )!
                .AsArray()
        );
        string? privateCwd = null;
        f.Main.WriteStage = (id, stage) =>
        {
            if (
                id != f.Owner.Id
                || stage != AtomicJsonWriteStage.AfterDirectorySync
                || privateCwd is not null
            )
                return;
            var envelope = JsonNode.Parse(
                File.ReadAllText(Path.Combine(f.Main.Data, "state", "sessions", "external.json"))
            )!;
            if (envelope["externalRuntime"]?["cwd"] is not JsonValue value)
                return;
            privateCwd = value.GetValue<string>();
            Plant(privateCwd);
            File.WriteAllText(
                Path.Combine(f.PeerDirectory, "peer.json"),
                new JsonObject
                {
                    ["probeSettingSources"] = true,
                    ["calls"] = new JsonArray(
                        NodeCall(
                            "write",
                            new JsonObject
                            {
                                ["filePath"] = Path.Combine(agent, "scoped-positive.txt"),
                                ["content"] = "allowed",
                            }
                        ),
                        NodeCall(
                            "write",
                            new JsonObject
                            {
                                ["filePath"] = Path.Combine(privateCwd, "scoped-denied.txt"),
                                ["content"] = "denied",
                            }
                        ),
                        NodeCall(
                            "exec",
                            new JsonObject
                            {
                                ["command"] =
                                    "printf denied > '"
                                    + Path.Combine(privateCwd, "exec-denied.txt")
                                    + "'",
                            }
                        )
                    ),
                }.ToJsonString()
            );
        };
        await f.RunAsync();
        Assert.Null(f.Owner.Entry.LastBackgroundProcessorFailure);
        Assert.NotNull(privateCwd);
        Assert.Equal(
            ClaudeSessionDriver.ContextDirectory(
                f.Main.Data,
                f.Lines("inputs.jsonl")[0]["id"]!.GetValue<string>()
            ),
            privateCwd
        );
        Assert.False(
            privateCwd.StartsWith(agent + Path.DirectorySeparatorChar, StringComparison.Ordinal)
        );
        Assert.Equal(
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute,
            File.GetUnixFileMode(privateCwd)
        );
        var first = f.Lines("inputs.jsonl")[0];
        Assert.Equal(privateCwd, first["cwd"]!.GetValue<string>());
        Assert.Equal(
            new[] { "user" },
            first["settingsProbe"]!["sources"]!.AsArray().Select(item => item!.GetValue<string>())
        );
        Assert.Equal(
            new[] { user },
            first["settingsProbe"]!["loaded"]!.AsArray().Select(item => item!.GetValue<string>())
        );
        Assert.Equal("owned-user-choice", first["settingsProbe"]!["model"]!.GetValue<string>());
        Assert.False(first["settingsProbe"]!["apiKeyHelper"]!.GetValue<bool>());
        Assert.False(first["settingsProbe"]!["hooks"]!.GetValue<bool>());
        Assert.False(File.Exists(marker));
        Assert.Equal(
            "allowed",
            await File.ReadAllTextAsync(Path.Combine(agent, "scoped-positive.txt"))
        );
        Assert.False(File.Exists(Path.Combine(privateCwd, "scoped-denied.txt")));
        Assert.False(File.Exists(Path.Combine(privateCwd, "exec-denied.txt")));
        var results = f.Lines("results.jsonl");
        Assert.False(results[0]["result"]?["isError"]?.GetValue<bool>() ?? false);
        Assert.True(results[1]["result"]!["isError"]!.GetValue<bool>());
        Assert.True(results[2]["result"]!["isError"]!.GetValue<bool>());
        Assert.Throws<InvalidDataException>(() =>
            ClaudeRuntimeConfiguration.Capture(
                new JsonObject { ["claudeCode"] = new JsonObject { ["workingDirectory"] = agent } }
            )
        );
    }
}
