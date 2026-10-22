using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class CommandAdministrationTests
{
    [Theory]
    [InlineData("default", "local", null)]
    [InlineData("local", "local", "local")]
    [InlineData("local/wire", "local/wire", "local/wire")]
    public async Task Model_inspection_preserves_catalog_selection_and_uses_leaf_effort_capabilities(
        string selection,
        string displayed,
        string? stored
    )
    {
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() }
        );
        await f.Configuration.SaveAsync(
            new JsonObject
            {
                ["yaml"] = """
                default: local
                providers:
                  local:
                    providerType: openai-responses
                    baseUrl: http://127.0.0.1:1/v1
                    models:
                      - id: wire
                        effort: {allowed: [none, low], default: low}
                """,
            }
        );
        var replies = new List<string>();
        var source = Source(replies);
        f.Manager.AttachChannel(source.Target, f.Owner);
        await f.Router.HandleExternalMessageAsync(source, Message("/model " + selection));
        Assert.Equal(stored, f.Owner.Metadata().Model);
        Assert.Contains($"model: `{displayed}`", replies.Single());
        var authority = await File.ReadAllTextAsync(f.Owner.AuthorityStore.AuthorityPath);
        replies.Clear();
        await f.Router.HandleExternalMessageAsync(source, Message("/model"));
        var reply = replies.Single();
        Assert.Contains($"model: `{displayed}`", reply);
        Assert.Contains("allowed: none, low", reply);
        Assert.Contains("effective=low", reply);
        Assert.Contains("model default: low", reply);
        if (displayed == "local")
            Assert.Contains("`local` (default, current)", reply);
        else
            Assert.Contains("`local` (default)", reply);
        Assert.Equal(authority, await File.ReadAllTextAsync(f.Owner.AuthorityStore.AuthorityPath));
        replies.Clear();
        await f.Router.HandleExternalMessageAsync(source, Message("/model --effort high"));
        Assert.Equal(stored, f.Owner.Metadata().Model);
        Assert.Null(f.Owner.Metadata().Effort);
        replies.Clear();
        await f.Router.HandleExternalMessageAsync(source, Message("/model --effort none"));
        Assert.Equal(stored, f.Owner.Metadata().Model);
        Assert.Equal("none", f.Owner.Metadata().Effort);
        Assert.Contains("effective=none", replies.Single());
    }

    [Fact]
    public async Task Skill_generic_main_fallback_and_explicit_administrator_selection_match_actual_Source_callers()
    {
        var genericSource = await SourceAsync(
            new JsonObject
            {
                ["command"] = "/skill",
                ["args"] = new JsonArray("list"),
                ["binding"] = "peer/main",
            }
        );
        var explicitSource = await SourceAsync(
            new JsonObject
            {
                ["command"] = "/skill",
                ["args"] = new JsonArray("list"),
                ["binding"] = "peer/main",
                ["explicit"] = true,
            }
        );
        Assert.Equal("main", SessionWait.Text(genericSource["effects"]![0]!["agentName"]));
        Assert.Equal("peer", SessionWait.Text(explicitSource["effects"]![0]!["agentName"]));
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() }
        );
        await f.Manager.CreateAgentAsync("peer");
        var peer = await f.Manager.RequiredAsync("peer/main");
        foreach (var agent in new[] { "main", "peer" })
        {
            var dir = Path.Combine(f.Manager.AgentDirectory(agent), "skills", agent + "-only");
            Directory.CreateDirectory(dir);
            await File.WriteAllTextAsync(
                Path.Combine(dir, "SKILL.md"),
                $"---\nname: {agent}-only\ndescription: Controlled skill\n---\nInstructions for {agent} <&>.\n"
            );
            await File.WriteAllTextAsync(
                Path.Combine(dir, "resource.txt"),
                "resource content must not be loaded"
            );
        }
        var replies = new List<string>();
        var source = Source(replies);
        f.Manager.AttachChannel(source.Target, peer);
        await f.Router.HandleExternalMessageAsync(source, Message("/skill list"));
        Assert.Contains("main-only", replies.Single());
        Assert.DoesNotContain("peer-only", replies.Single());
        var events = new List<SessionRuntimeEvent>();
        f.Manager.Changed += events.Add;
        await f.Router.HandleMessageAsync(
            new(peer.Id, "webui"),
            new("/skill show peer-only", null)
        );
        var reply = SessionWait.Text(
            events.Single(e => e.Kind == SessionEventKind.CommandReply).Data?["parts"]?[0]?["text"]
        );
        Assert.Contains("Instructions for peer <&>.", reply);
        Assert.Contains("resource.txt", reply);
        Assert.DoesNotContain("resource content must not be loaded", reply);
        Assert.Empty(peer.History());
        Assert.Empty(peer.Entry.Snapshot().Queue);
    }

    [Fact]
    public async Task Session_flags_model_effort_atomicity_name_threshold_snapshot_and_Agent_inheritance_have_real_persisted_effects()
    {
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() }
        );
        await f.Configuration.SaveAsync(
            new JsonObject
            {
                ["yaml"] = """
                default: local/wire
                providers:
                  local:
                    providerType: openai-responses
                    baseUrl: http://127.0.0.1:1/v1
                    models:
                      - id: wire
                      - id: other
                        effort: {allowed: [none, low], default: low}
                  virtual:
                    providerType: failover
                    targets: [local/wire, local/other]
                """,
            }
        );
        var replies = new List<string>();
        var source = Source(replies);
        f.Manager.AttachChannel(source.Target, f.Owner);
        await f.Router.HandleExternalMessageAsync(source, Message("/agent create peer --no-main"));
        Assert.True(
            File.Exists(Path.Combine(f.Manager.AgentDirectory("peer"), "memory", "SOUL.md"))
        );
        Assert.Null(f.Manager.Find("peer/main"));
        var initial = f.Owner.Entry.Snapshot();
        await f.Router.HandleExternalMessageAsync(source, Message("/model other --effort high"));
        Assert.Equal(
            initial.AuthorityEnvelope["model"]?.ToJsonString(),
            f.Owner.Entry.Snapshot().AuthorityEnvelope["model"]?.ToJsonString()
        );
        Assert.Null(f.Owner.Metadata().Effort);
        await f.Router.HandleExternalMessageAsync(source, Message("/model wire --effort high"));
        Assert.Equal("local/wire", f.Owner.Metadata().Model);
        Assert.Equal("high", f.Owner.Metadata().Effort);
        await f.Router.HandleExternalMessageAsync(source, Message("/model other"));
        Assert.Equal("local/other", f.Owner.Metadata().Model);
        Assert.Null(f.Owner.Metadata().Effort);
        await f.Router.HandleExternalMessageAsync(
            source,
            Message("/session child-model virtual --effort none")
        );
        Assert.Equal("virtual", f.Owner.Metadata().ChildModel);
        Assert.Equal("none", f.Owner.Metadata().ChildEffort);
        var file = Path.Combine(f.Manager.AgentDirectory("peer"), "memory", "SELECTED.md");
        await File.WriteAllTextAsync(file, "Selected memory marker.");
        await f.Router.HandleExternalMessageAsync(
            source,
            Message("/session create peer target --system-prompt-file memory/SELECTED.md")
        );
        var child = await f.Manager.RequiredAsync("peer/target");
        Assert.Equal("virtual", child.Metadata().Model);
        Assert.Equal("none", child.Metadata().Effort);
        // Source records the selection but defers a virtual route's snapshot until an actual leaf is selected.
        Assert.Equal(
            "",
            SessionWait.Text(child.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"])
        );
        Assert.Equal(
            new[] { "memory/SELECTED.md" },
            SessionWait.Strings(child.Entry.Snapshot().AuthorityEnvelope["systemPromptFiles"])
        );
        Assert.Equal(
            child.Id,
            SessionWait.Text(f.Manager.ChannelBinding(source.Target)?["sessionId"])
        );
        await f.Router.HandleExternalMessageAsync(
            source,
            Message("/session rename Project With Spaces")
        );
        Assert.Equal(
            "Project With Spaces",
            SessionWait.Text(f.Manager.Catalog.Get(child.Id)?["displayName"])
        );
        await f.Router.HandleExternalMessageAsync(
            source,
            Message("/session compact-threshold 8.75k")
        );
        Assert.Equal(8750, child.Metadata().CompactThreshold);
        var snapshot = SessionWait.Text(
            child.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]
        );
        await f.Manager.CreateAgentAsync(
            "base",
            createMainSession: false,
            initialMemory: "Inherited memory marker."
        );
        await f.Router.HandleExternalMessageAsync(source, Message("/agent inherit peer base"));
        Assert.Equal("base", f.Manager.AgentInherit("peer"));
        Assert.Equal(
            snapshot,
            SessionWait.Text(child.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"])
        );
        await f.Router.HandleExternalMessageAsync(source, Message("/session refresh-snapshot"));
        // Explicit selected-memory sources remain selected instead of being replaced with inheritance defaults.
        Assert.Equal(
            new[] { "memory/SELECTED.md" },
            SessionWait.Strings(child.Entry.Snapshot().AuthorityEnvelope["systemPromptFiles"])
        );
        var disk = JsonNode.Parse(await File.ReadAllTextAsync(child.AuthorityStore.AuthorityPath))!;
        Assert.Equal(8750, SessionWait.Number(disk["compactThresholdTokens"]));
        Assert.Equal("none", SessionWait.Text(disk["effort"]));
        await f.Router.HandleExternalMessageAsync(
            source,
            Message("/session compact-threshold clear")
        );
        Assert.Null(child.Metadata().CompactThreshold);
        await f.Router.HandleExternalMessageAsync(source, Message("/session rename -"));
        Assert.Null(child.Metadata().DisplayName);
        var count = f.Manager.Catalog.List().Length;
        await f.Router.HandleExternalMessageAsync(
            source,
            Message("/session create peer invalid --model missing --extra")
        );
        Assert.Equal(count, f.Manager.Catalog.List().Length);
        Assert.Equal(
            child.Id,
            SessionWait.Text(f.Manager.ChannelBinding(source.Target)?["sessionId"])
        );
    }

    [Fact]
    public async Task Timers_keep_command_authority_but_search_uses_recall_policy_and_message_previews_use_active_offsets()
    {
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() }
        );
        var policy = Path.Combine(f.Data, "state", "tool-authorization.yaml");
        await File.WriteAllTextAsync(
            policy,
            """
            version: 1
            rules:
              - id: deny-model-timers
                action: deny
                tool: {source: builtin, name: create_timer}
              - id: deny-recall
                reason: synthetic recall refusal
                action: deny
                tool: {source: builtin, name: recall}
            """
        );
        f.Manager.Authorization.Invalidate();
        var replies = new List<string>();
        var source = Source(replies);
        f.Manager.AttachChannel(source.Target, f.Owner);
        await f.Router.HandleExternalMessageAsync(
            source,
            Message("/timer after 3600 --prefix ignored -- --new-session literal")
        );
        Assert.Single(f.Manager.Timers.List(f.Owner.Id));
        Assert.Contains("Timer created", replies.Single());
        Assert.Equal(
            "--new-session literal",
            SessionWait.Text(f.Manager.Timers.List(f.Owner.Id)[0]?["message"])
        );
        replies.Clear();
        await f.Router.HandleExternalMessageAsync(source, Message("/search --limit 2 query text"));
        Assert.Contains("synthetic recall refusal", replies.Single());
        Assert.Empty(f.Owner.History());
        var old = await f.Manager.CreateNamedAsync("main", "unrelated", null, null);
        await ForkClearLifecycleTests.AppendAsync(
            f.Owner,
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "first" }),
            },
            new JsonObject
            {
                ["role"] = "model",
                ["modelVisible"] = false,
                ["parts"] = new JsonArray(new JsonObject { ["text"] = new string('x', 140) }),
            }
        );
        // Active offsets deliberately diverge from retained Archive seqs after clear.
        await f.Manager.ClearAsync(f.Owner);
        await ForkClearLifecycleTests.AppendAsync(
            f.Owner,
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "fresh" }),
            },
            new JsonObject
            {
                ["role"] = "model",
                ["modelVisible"] = false,
                ["parts"] = new JsonArray(new JsonObject { ["text"] = new string('y', 140) }),
            }
        );
        Assert.True(f.Owner.History()[0]["__meta"]!["seq"]!.GetValue<long>() > 1);
        replies.Clear();
        await f.Router.HandleExternalMessageAsync(source, Message("/messages -1"));
        Assert.Contains("[1", replies.Single());
        Assert.Contains("[non-context]", replies.Single());
        Assert.DoesNotContain(new string('y', 110), replies.Single());
        replies.Clear();
        await f.Router.HandleExternalMessageAsync(source, Message("/messages -999 1"));
        Assert.Contains("fresh", replies.Single());
        Assert.DoesNotContain("first", replies.Single());
        replies.Clear();
        await f.Router.HandleExternalMessageAsync(source, Message("/timer list"));
        Assert.Contains("--new-session literal", replies.Single());
        var timer = SessionWait.Text(f.Manager.Timers.List(f.Owner.Id)[0]?["id"]);
        await f.Router.HandleExternalMessageAsync(source, Message("/timer delete " + timer));
        Assert.Empty(f.Manager.Timers.List(f.Owner.Id));
    }
}
