using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class AgentDeletionTests
{
    private static ResponsesClientOptions Options =>
        new(new Uri("http://127.0.0.1:1"), "wire", "", "", "", 713);

    private static TaskCompletionSource Signal() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private static string Data(string root) => Path.Combine(root, "data");

    private static string Authority(string root, string id) =>
        Path.Combine(Data(root), "state", "sessions", id + ".json");

    private static SessionManager Manager(string root, bool canonical = true)
    {
        var paths = HostPaths.ForDataRoot(Data(root), root, environment: _ => null);
        return new(
            Data(root),
            canonical ? paths.AgentsRoot : Path.Combine(root, "work"),
            Options,
            HostModels.ForTest(Options),
            hostPaths: canonical ? paths : null
        );
    }

    private static async Task<List<string>> Command(
        ExternalChannelFixture f,
        string text,
        string conversation = "agent-delete"
    )
    {
        var replies = new List<string>();
        var source = new ExternalChannelContext(
            "alpha",
            "telegram",
            conversation,
            "11",
            "operator",
            value =>
            {
                replies.Add(value);
                return Task.CompletedTask;
            }
        );
        await f.Router.HandleExternalMessageAsync(
            source,
            new([new JsonObject { ["text"] = text }])
        );
        return replies;
    }

    [Fact]
    public async Task Authorized_external_command_confirms_without_binding_then_deletes_attached_members_but_retains_raw_children_metadata_and_Archive()
    {
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() }
        );
        await f.Manager.CreateAgentAsync("target", inherit: "main");
        await f.Manager.CreateAgentAsync("survivor");
        var target = await f.Manager.RequiredAsync("target/main");
        var (child, _) = await f.Manager.CreateChildAsync(
            target,
            "child",
            "survivor",
            null,
            null,
            null
        );
        var (grandchild, _) = await f.Manager.CreateChildAsync(
            child,
            "grand",
            null,
            null,
            null,
            null
        );
        await f.Manager.SetAgentInheritAsync("survivor", "target");
        await ForkClearLifecycleTests.AppendAsync(
            target,
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(
                    new JsonObject { ["text"] = "retained Archive evidence" }
                ),
            }
        );
        var history = target
            .Archive.ReadMessages()
            .Select(row => row.Message.ToJsonString())
            .ToArray();
        var branches = target.Archive.ReadBranch();
        Assert.Null(f.Manager.ChannelBinding("telegram:agent-delete"));
        Assert.Contains("Usage:", (await Command(f, "/agent delete")).Single());
        Assert.Contains("--confirm", (await Command(f, "/agent delete target")).Single());
        Assert.NotNull(f.Manager.Catalog.Get(target.Id));
        f.Manager.AttachChannel("telegram:agent-delete", target);
        f.Manager.AttachChannel("webui:selected", target);
        var reply = (await Command(f, "/agent delete target ignored --confirm")).Single();
        Assert.Contains("Deleted 1 session(s)", reply);
        Assert.Null(f.Manager.Catalog.Get(target.Id));
        Assert.Null(f.Manager.ChannelBinding("telegram:agent-delete"));
        Assert.Null(f.Manager.ChannelBinding("webui:selected"));
        Assert.Equal(target.Id, f.Manager.Catalog.Get(child.Id)!["parentSessionId"]!.ToString());
        Assert.Equal(
            child.Id,
            f.Manager.Catalog.Get(grandchild.Id)!["parentSessionId"]!.ToString()
        );
        Assert.Equal("main", f.Manager.AgentInherit("target"));
        Assert.Equal("target", f.Manager.AgentInherit("survivor"));
        Assert.False(Directory.Exists(Path.Combine(f.Work, "agents", "target")));
        Assert.Equal(
            history,
            target.Archive.ReadMessages().Select(row => row.Message.ToJsonString())
        );
        Assert.Equal(branches, target.Archive.ReadBranch());
        await Assert.ThrowsAnyAsync<InvalidOperationException>(() =>
            target.Entry.SaveLane.SaveStrictAsync()
        );
        Assert.False(File.Exists(Path.Combine(f.Data, "state", "sessions", target.Id + ".json")));
        Assert.Contains("not found", (await Command(f, "/agent delete absent --confirm")).Single());
        await f.Manager.CreateAgentAsync("target", createMainSession: false);
        await Assert.ThrowsAnyAsync<InvalidDataException>(() =>
            f.Manager.CreateNamedAsync("target", "main", null, null)
        );
        Assert.Contains(
            "Deleted 0 session(s)",
            (await Command(f, "/agent delete target --confirm")).Single()
        );
        Assert.NotNull(f.Manager.Find(f.Owner.Id));
    }

    [Fact]
    public async Task Canonical_main_and_literal_default_keep_unprefixed_members_and_old_move_aliases_are_not_selected()
    {
        using var temp = new TempDirectory();
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        Directory.CreateDirectory(manager.AgentDirectory("main"));
        var main = await manager.CreateNamedAsync("main", "main", null, null);
        var defaultSession = await manager.CreateNamedAsync("main", "default", null, null);
        await manager.CreateAgentAsync("default");
        await manager.CreateAgentAsync("old");
        var moved = await manager.RequiredAsync("old/main");
        await manager.MoveIdentityAsync(
            main,
            new()
            {
                ["sessionId"] = moved.Id,
                ["newAgentName"] = "main",
                ["newSessionId"] = "moved",
            }
        );
        Assert.Equal("main/moved", moved.Id);
        Assert.Empty(await manager.DeleteAgentFromCommandAsync("old"));
        Assert.NotNull(manager.Catalog.Get("main/moved"));
        var protectedMain = await Assert.ThrowsAsync<InvalidDataException>(() =>
            manager.DeleteAgentAsync("main")
        );
        Assert.Contains("cannot be deleted", protectedMain.Message);
        Assert.Equal(new[] { "main/moved" }, await manager.DeleteAgentFromCommandAsync("main"));
        Assert.NotNull(manager.Catalog.Get(main.Id));
        Assert.NotNull(manager.Catalog.Get(defaultSession.Id));
        Assert.Equal(
            new[] { "default/main" },
            await manager.DeleteAgentFromCommandAsync("default")
        );
        Assert.NotNull(manager.Catalog.Get("default"));
        Assert.Null(manager.Catalog.Resolve("old/main")["sessionId"]);
    }

    [Fact]
    public async Task Retained_main_refuses_before_effects_and_nonmain_membership_reopens_with_command_metadata_intact()
    {
        using var temp = new TempDirectory();
        string[] before;
        await using (var manager = Manager(temp.Path, canonical: false))
        {
            await manager.LoadAsync();
            await manager.CreateAgentAsync("target", inherit: "main");
            var main = await manager.CreateNamedAsync("main", "kept", null, null);
            before = Directory.GetFiles(temp.Path, "*", SearchOption.AllDirectories);
            var error = await Assert.ThrowsAsync<InvalidDataException>(() =>
                manager.DeleteAgentFromCommandAsync("main")
            );
            Assert.Contains("folder is shared", error.Message);
            Assert.Equal(before, Directory.GetFiles(temp.Path, "*", SearchOption.AllDirectories));
            Assert.NotNull(manager.Catalog.Get(main.Id));
            await manager.DeleteAgentFromCommandAsync("target");
        }
        await using var reopened = Manager(temp.Path, canonical: false);
        await reopened.LoadAsync();
        Assert.DoesNotContain("target", reopened.Agents());
        Assert.Equal("main", reopened.AgentMetadata["target"]!["inherit"]!.ToString());
        Assert.NotNull(reopened.Catalog.Get("kept"));
        var envelope = JsonNode.Parse(
            await File.ReadAllTextAsync(Path.Combine(Data(temp.Path), "state", "agents.json"))
        )!;
        Assert.Equal(2, envelope["version"]!.GetValue<int>());
        Assert.Empty(envelope["agents"]!.AsArray());
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Supported_retained_loader_preserves_prefix_versus_metadata_selection_and_outside_selection_folder_safety(
        bool command
    )
    {
        using var temp = new TempDirectory();
        var data = Data(temp.Path);
        Directory.CreateDirectory(Path.Combine(data, "agents", "id-prefix"));
        Directory.CreateDirectory(Path.Combine(data, "agents", "metadata-owner"));
        await SessionCatalogMigrationTests.Authority(data, "id-prefix/member");
        var row = SessionCatalogTests.Row("id-prefix/member", 0);
        row["agent"] = "metadata-owner";
        var rows = new JsonObject { ["id-prefix/member"] = row };
        if (command)
        {
            await SessionCatalogMigrationTests.Authority(data, "metadata-owner/selected");
            var selected = SessionCatalogTests.Row("metadata-owner/selected", 0);
            selected["agent"] = "metadata-owner";
            rows["metadata-owner/selected"] = selected;
        }
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "sessions.json"),
            new JsonObject { ["sessions"] = rows }.ToJsonString()
        );
        await using (var manager = Manager(temp.Path))
        {
            await manager.LoadAsync();
            Assert.Empty(manager.Owners());
            Assert.Equal(
                "metadata-owner",
                manager.Catalog.Get("id-prefix/member")!["agent"]!.ToString()
            );
            if (command)
            {
                var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                    manager.DeleteAgentFromCommandAsync("metadata-owner")
                );
                Assert.Contains("outside this command's selection", error.Message);
                Assert.True(Directory.Exists(manager.AgentDirectory("metadata-owner")));
                Assert.Null(manager.Catalog.Get("metadata-owner/selected"));
                Assert.False(File.Exists(Authority(temp.Path, "metadata-owner/selected")));
                Assert.Null(manager.Find("id-prefix/member"));
                Assert.Equal(
                    new[] { "id-prefix/member" },
                    await manager.DeleteAgentFromCommandAsync("id-prefix")
                );
            }
            else
            {
                Assert.Empty(await manager.DeleteAgentAsync("id-prefix"));
                Assert.NotNull(manager.Catalog.Get("id-prefix/member"));
                Assert.Equal(
                    new[] { "id-prefix/member" },
                    await manager.DeleteAgentAsync("metadata-owner")
                );
            }
            Assert.Null(manager.Catalog.Get("id-prefix/member"));
            Assert.False(File.Exists(Authority(temp.Path, "id-prefix/member")));
        }
        await using var reopened = Manager(temp.Path);
        await reopened.LoadAsync();
        Assert.Empty(reopened.Catalog.List());
    }
}
