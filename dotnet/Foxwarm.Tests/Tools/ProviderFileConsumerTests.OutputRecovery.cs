using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class ProviderFileConsumerTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Remote_readonly_output_retains_authorized_Main_spool(bool unified)
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        Success(await f.Manager.SelectNodeAsync(f.Owner, "fixture/readonly"));
        var content = string.Concat(Enumerable.Range(1, 5000).Select(i => $"entry-{i:D5}\n"));
        await f.Seed("input.txt", Encoding.UTF8.GetBytes(content));
        var result = unified
            ? await f.Call(
                "call_tool",
                new JsonObject
                {
                    ["toolId"] = "node:fixture/readonly/read",
                    ["args"] = Args("input.txt"),
                }
            )
            : await f.Call("read", Args("input.txt"));
        Success(result);
        Assert.True(
            result["outputFullPath"] is not null,
            "Completed remote read has no complete-output locator: "
                + result["toolOutputGuardError"]
        );
        Assert.Equal("master", result["outputFullNode"]!.GetValue<string>());
        var path = result["outputFullPath"]!.GetValue<string>();
        Assert.StartsWith(content, await File.ReadAllTextAsync(path));
        var retrieved = await f.Call(
            "call_tool",
            new JsonObject
            {
                ["toolId"] = "node:master/read",
                ["args"] = new JsonObject
                {
                    ["filePath"] = path,
                    ["startLine"] = 5000,
                    ["endLine"] = 5000,
                },
            }
        );
        Success(retrieved);
        Assert.Contains("entry-05000", retrieved["output"]!.GetValue<string>());
    }

    private static async Task<string> ExpirePolicyDuringLargeResult(Fixture f)
    {
        var policy = Path.Combine(f.Data, "state", "tool-authorization.yaml");
        f.Registry.Register(
            new JsonObject { ["name"] = "large_policy_result" },
            "builtin",
            false,
            async (_, _, _) =>
            {
                await File.WriteAllTextAsync(policy, "version: [invalid");
                f.Manager.Authorization.Invalidate();
                return new JsonObject
                {
                    ["output"] = new string('x', 50_000),
                    ["status"] = "effect-completed",
                };
            }
        );
        var result = await f.Call("large_policy_result", new JsonObject());
        Success(result);
        Assert.Equal("effect-completed", result["status"]!.GetValue<string>());
        Assert.NotEmpty(result["toolOutputGuardError"]!.GetValue<string>());
        return policy;
    }

    [Fact]
    public async Task Guard_policy_failure_retains_the_existing_terminal_signal()
    {
        await using var f = await Fixture.Create();
        await ExpirePolicyDuringLargeResult(f);
        Assert.True(
            f.Tools.PolicyUnavailable,
            "The guard observed two failed policy reads, but the executor's terminal flag is false."
        );
    }

    [Fact]
    public async Task Persistently_unavailable_guard_policy_blocks_preparation_and_dispatch()
    {
        await using var f = await Fixture.Create();
        await ExpirePolicyDuringLargeResult(f);
        Assert.Throws<ToolAuthorizationUnavailableException>(() =>
            f.Manager.ModelDefinitions(f.Owner)
        );
        var prepared = await f.Tools.PrepareDirectExecAsync(
            new JsonObject
            {
                ["id"] = "prepare",
                ["name"] = "exec",
                ["args"] = new JsonObject { ["command"] = "must-not-run" },
            },
            CancellationToken.None
        );
        Assert.True(prepared!.PolicyUnavailable);
        var result = await f.Call("read", Args("missing"));
        Assert.Equal(
            ToolAuthorizationUnavailableException.Code,
            result["error"]!["type"]!.GetValue<string>()
        );
        Assert.True(f.Tools.PolicyUnavailable);
    }

    [Fact]
    public async Task Guard_policy_failure_stops_batch_even_after_policy_repair()
    {
        await using var f = await Fixture.Create();
        var policy = await ExpirePolicyDuringLargeResult(f);
        await File.WriteAllTextAsync(policy, "version: 1\n");
        f.Manager.Authorization.Invalidate();
        _ = f.Manager.ModelDefinitions(f.Owner);
        var message = new JsonObject { ["role"] = "tool", ["parts"] = new JsonArray() };
        await Assert.ThrowsAsync<ToolAuthorizationUnavailableException>(() =>
            f.Tools.CompleteBatchAsync(message, false)
        );
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Guard_policy_failure_ends_the_real_turn_after_optional_policy_repair(
        bool repaired
    )
    {
        await using var f = await Fixture.Create();
        var policy = Path.Combine(f.Data, "state", "tool-authorization.yaml");
        f.Registry.Register(
            new JsonObject { ["name"] = "large_policy_result" },
            "builtin",
            false,
            async (_, _, _) =>
            {
                await File.WriteAllTextAsync(policy, "version: [invalid");
                f.Manager.Authorization.Invalidate();
                return new JsonObject
                {
                    ["output"] = new string('x', 50_000),
                    ["status"] = "effect-completed",
                };
            }
        );
        f.Owner.Entry.StructuredProgress = progress =>
        {
            if (progress.Type == "tool-calls-finish" && repaired)
            {
                File.WriteAllText(policy, "version: 1\n");
                f.Manager.Authorization.Invalidate();
            }
        };
        var chat = new PolicyPreparationChat(f);
        var host = new LocalSessionTurnHost(f.Owner.Entry, f.Owner.AuthorityStore, chat, f.Tools);
        Assert.True(await host.TryClaimBusyAsync());
        var input = QueueItem.UserText("policy recovery");
        await f.Owner.Entry.SaveLane.AdmitAsync(input, SaveKind.Strict);
        await host.AppendQueuedInputsAsync(f.Owner.Entry.WithState(state => state.Queue.ToArray()));
        await Assert.ThrowsAsync<ToolAuthorizationUnavailableException>(() =>
            host.ChatAsync("policy recovery")
        );
        Assert.Equal(1, chat.SuccessfulPreparations);
        Assert.True(f.Tools.PolicyUnavailable);
        var toolMessage = f
            .Owner.History()
            .Single(message => message["role"]?.GetValue<string>() == "tool");
        var response = toolMessage["parts"]![0]!["functionResponse"]!["response"]!;
        Assert.Null(response["error"]);
        Assert.Equal("effect-completed", response["status"]!.GetValue<string>());
        Assert.NotNull(response["toolOutputGuardError"]);
    }

    [Fact]
    public async Task Repaired_policy_after_the_first_tool_keeps_later_batch_slots_skipped()
    {
        await using var f = await Fixture.Create();
        var policy = Path.Combine(f.Data, "state", "tool-authorization.yaml");
        var completed = false;
        var repaired = false;
        var laterEffects = 0;
        f.Registry.Register(
            new JsonObject { ["name"] = "large_policy_result" },
            "builtin",
            false,
            async (_, _, _) =>
            {
                await File.WriteAllTextAsync(policy, "version: [invalid");
                f.Manager.Authorization.Invalidate();
                completed = true;
                return new JsonObject
                {
                    ["output"] = new string('x', 50_000),
                    ["status"] = "effect-completed",
                };
            }
        );
        f.Registry.Register(
            new JsonObject { ["name"] = "later_effect" },
            "builtin",
            false,
            (_, _, _) =>
            {
                laterEffects++;
                return Task.FromResult(new JsonObject { ["output"] = "later effect" });
            }
        );
        void Repair(SessionRuntimeEvent _)
        {
            if (!completed || f.Owner.ToolActive || repaired)
                return;
            File.WriteAllText(policy, "version: 1\n");
            f.Manager.Authorization.Invalidate();
            repaired = true;
        }
        f.Owner.Changed += Repair;
        var chat = new PolicyPreparationChat(f, includeSibling: true);
        var host = new LocalSessionTurnHost(f.Owner.Entry, f.Owner.AuthorityStore, chat, f.Tools);
        try
        {
            Assert.True(await host.TryClaimBusyAsync());
            await f.Owner.Entry.SaveLane.AdmitAsync(
                QueueItem.UserText("policy repair between tools"),
                SaveKind.Strict
            );
            await host.AppendQueuedInputsAsync(
                f.Owner.Entry.WithState(state => state.Queue.ToArray())
            );
            await Assert.ThrowsAsync<ToolAuthorizationUnavailableException>(() =>
                host.ChatAsync("policy recovery")
            );
            Assert.True(repaired);
            _ = f.Manager.ModelDefinitions(f.Owner);
            Assert.True(f.Tools.PolicyUnavailable);
            Assert.Equal(0, laterEffects);
            Assert.Equal(1, chat.SuccessfulPreparations);
            var parts = f
                .Owner.History()
                .Single(message => message["role"]?.GetValue<string>() == "tool")[
                "parts"
            ]!.AsArray();
            Assert.Equal(2, parts.Count);
            Assert.Equal(
                "large-policy",
                parts[0]!["functionResponse"]!["tool_use_id"]!.GetValue<string>()
            );
            Assert.Null(parts[0]!["functionResponse"]!["response"]!["error"]);
            Assert.Equal(
                "later-effect",
                parts[1]!["functionResponse"]!["tool_use_id"]!.GetValue<string>()
            );
            Assert.Equal(
                "tool_call_skipped",
                parts[1]!["functionResponse"]!["response"]!["error"]!["type"]!.GetValue<string>()
            );
            f.Tools.BeginTurn();
            Assert.False(f.Tools.PolicyUnavailable);
        }
        finally
        {
            f.Owner.Changed -= Repair;
        }
    }

    [Fact]
    public async Task Readonly_execution_capability_does_not_bypass_denied_Main_storage()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        Success(await f.Manager.SelectNodeAsync(f.Owner, "fixture/readonly"));
        await f.Seed("input.txt", Encoding.UTF8.GetBytes(new string('x', 50_000)));
        await File.WriteAllTextAsync(
            Path.Combine(f.Data, "state", "tool-authorization.yaml"),
            "version: 1\ndefaultAction: deny\nrules:\n- action: allow\n  node: { current: true }\n"
        );
        f.Manager.Authorization.Invalidate();
        var result = await f.Call("read", Args("input.txt"));
        Success(result);
        Assert.NotNull(result["toolOutputGuardError"]);
        Assert.Null(result["outputFullPath"]);
        Assert.False(f.Tools.PolicyUnavailable);
        Assert.False(Directory.Exists(Path.Combine(f.Work, ".temp", "tool-output")));
        Assert.DoesNotContain(
            await f.Requests(),
            call => call["request"]?["operation"]?.GetValue<string>() == "write"
        );
    }

    private sealed class PolicyPreparationChat(Fixture fixture, bool includeSibling = false)
        : IChatService
    {
        public int SuccessfulPreparations { get; private set; }

        public Task<ChatResult> ChatAsync(
            string sessionId,
            IReadOnlyList<JsonObject> history,
            CancellationToken token
        )
        {
            // Reuse the same policy-filtered definitions owner as ordinary SessionChatService.
            _ = fixture.Manager.ModelDefinitions(fixture.Owner);
            SuccessfulPreparations++;
            var parts = new JsonArray(
                new JsonObject
                {
                    ["functionCall"] = new JsonObject
                    {
                        ["id"] = "large-policy",
                        ["name"] = "large_policy_result",
                        ["args"] = new JsonObject(),
                    },
                }
            );
            if (includeSibling)
                parts.Add(
                    new JsonObject
                    {
                        ["functionCall"] = new JsonObject
                        {
                            ["id"] = "later-effect",
                            ["name"] = "later_effect",
                            ["args"] = new JsonObject(),
                        },
                    }
                );
            return Task.FromResult(
                SuccessfulPreparations == 1
                    ? new ChatResult(new JsonObject { ["role"] = "model", ["parts"] = parts })
                    : ChatResult.Text("continued")
            );
        }
    }
}
