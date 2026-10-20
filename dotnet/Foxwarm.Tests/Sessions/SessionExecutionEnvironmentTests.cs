using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class SessionExecutionEnvironmentTests
{
    private static ResponsesClientOptions Options =>
        new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);

    private static async Task Seed(string data, string id, JsonObject context)
    {
        using var catalog = new SessionCatalog(data);
        catalog.Initialize();
        await SessionCatalogMigrationTests.Authority(data, id);
        var file = Path.Combine(data, "state", "sessions", id + ".json");
        var raw = JsonNode.Parse(await File.ReadAllTextAsync(file))!.AsObject();
        foreach (var pair in context)
            raw[pair.Key] = pair.Value?.DeepClone();
        await File.WriteAllTextAsync(file, raw.ToJsonString());
        var row = SessionCatalogTests.Row(id, 0);
        foreach (var pair in context)
            row[pair.Key] = pair.Value?.DeepClone();
        catalog.Upsert([row]);
    }

    [Theory]
    [InlineData(null, null, true)]
    [InlineData("", "", true)]
    [InlineData("\ufeff \tmaster\n", "\ufeff \t", true)]
    [InlineData("master", "/owned/process/workspace/.", true)]
    [InlineData("master", "/owned/process/workspace/../workspace/", true)]
    [InlineData("master", "workspace", true)]
    [InlineData("master", "/different", true)]
    [InlineData("remote", "C:\\remote\\project", true)]
    [InlineData("Master", null, true)]
    [InlineData("provider/instance", "relative", true)]
    [InlineData("\u0085master", null, false)]
    public void Master_admission_keeps_raw_cwd_for_effect_resolution_and_retains_case_sensitive_and_qualified_node_boundaries(
        string? node,
        string? cwd,
        bool supported
    )
    {
        var context = new JsonObject { ["currentNode"] = node, ["cwd"] = cwd };
        Action validate = () =>
            SessionManager.ValidateExecutionEnvironment(
                context,
                "/owned/process/workspace",
                "/owned/process"
            );
        if (supported)
            validate();
        else
            Assert.Throws<InvalidDataException>(validate);
    }

    [Fact]
    public void Relative_and_home_values_do_not_require_admission_time_filesystem_validation()
    {
        SessionManager.ValidateExecutionEnvironment(
            new JsonObject { ["cwd"] = "." },
            "/owned/process",
            "/owned/process"
        );
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        foreach (var cwd in new[] { "~", "~/.", "~\\." })
            SessionManager.ValidateExecutionEnvironment(
                new JsonObject { ["cwd"] = cwd },
                home,
                "/owned/process"
            );
        SessionManager.ValidateExecutionEnvironment(
            new JsonObject { ["cwd"] = "workspace" },
            "/owned/process/workspace",
            "/owned/process"
        );
    }

    [Theory]
    [InlineData("remote")]
    [InlineData("Master")]
    [InlineData("provider/instance")]
    public async Task Offline_remote_session_admits_history_and_allows_Main_owned_deletion(
        string node
    )
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        await Seed(data, "foreign", new JsonObject { ["currentNode"] = node });
        var file = Path.Combine(data, "state", "sessions", "foreign.json");
        var original = await File.ReadAllTextAsync(file);
        await using var manager = new SessionManager(
            data,
            work,
            Options,
            HostModels.ForTest(Options)
        );
        await manager.LoadAsync();
        Assert.Empty(manager.Owners());
        Assert.Equal(node, manager.Catalog.Get("foreign")!["currentNode"]!.GetValue<string>());
        await new SessionRuntime(manager).UpdateDisplayNameAsync("foreign", "Inspectable metadata");
        var owner = await manager.RequiredAsync("foreign");
        Assert.Equal(node, manager.CurrentNode(owner));
        Assert.False(manager.Nodes.Online(node));
        Assert.Equal(original, await File.ReadAllTextAsync(file));
        Assert.Equal("exact", manager.Catalog.Resolve("foreign")["kind"]!.GetValue<string>());
        Assert.Same(owner, await manager.RequiredAsync("foreign"));
        await manager.DeleteAsync("foreign");
        Assert.Null(manager.Catalog.Get("foreign"));
    }

    [Fact]
    public async Task Malformed_Node_identity_cannot_arm_a_siblings_original_deadline()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        await Seed(data, "deadline", new JsonObject());
        await Seed(
            data,
            "foreign",
            new JsonObject { ["currentNode"] = "provider/instance/invalid" }
        );
        var file = Path.Combine(data, "state", "sessions", "deadline.json");
        var raw = JsonNode.Parse(await File.ReadAllTextAsync(file))!.AsObject();
        raw["meta"]!["wait"] = new JsonObject
        {
            ["id"] = "original",
            ["startedAt"] = 1,
            ["timeoutSeconds"] = 1,
            ["declarationVersion"] = 1,
        };
        await File.WriteAllTextAsync(file, raw.ToJsonString());
        using (var catalog = new SessionCatalog(data))
        {
            catalog.Initialize();
            var row = SessionCatalogTests.Row("deadline", 0);
            row["meta"]!["wait"] = raw["meta"]!["wait"]!.DeepClone();
            var foreign = catalog.Get("foreign")!;
            foreign["queueLength"] = 1;
            catalog.Upsert([row, foreign]);
        }
        await using var manager = new SessionManager(
            data,
            work,
            Options,
            HostModels.ForTest(Options)
        );
        await Assert.ThrowsAsync<InvalidDataException>(() => manager.LoadAsync());
        await Task.Delay(100);
        Assert.Null(manager.Find("foreign"));
        var owner = manager.Find("deadline")!;
        Assert.Equal("original", owner.WaitSnapshot()!["id"]!.GetValue<string>());
        Assert.Empty(owner.Entry.Snapshot().History);
        Assert.Empty(owner.Entry.Snapshot().Queue);
        Assert.Equal(raw.ToJsonString(), await File.ReadAllTextAsync(file));
    }

    [Fact]
    public async Task Source_migration_keeps_raw_master_cwd_without_creating_or_repairing_that_directory()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        await SessionCatalogMigrationTests.Authority(data, "foreign");
        var file = Path.Combine(data, "state", "sessions", "foreign.json");
        var raw = JsonNode.Parse(await File.ReadAllTextAsync(file))!.AsObject();
        raw["cwd"] = Path.Combine(temp.Path, "different");
        await File.WriteAllTextAsync(file, raw.ToJsonString());
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "sessions.json"),
            new JsonObject
            {
                ["sessions"] = new JsonObject
                {
                    ["foreign"] = SessionCatalogTests.Row("foreign", 0),
                },
            }.ToJsonString()
        );
        await using var manager = new SessionManager(
            data,
            work,
            Options,
            HostModels.ForTest(Options)
        );
        await manager.LoadAsync();
        Assert.Empty(manager.Owners());
        Assert.Equal(
            raw["cwd"]!.GetValue<string>(),
            manager.Catalog.Get("foreign")!["cwd"]!.GetValue<string>()
        );
        var owner = await manager.RequiredAsync("foreign");
        Assert.Equal(
            raw["cwd"]!.GetValue<string>(),
            owner.Entry.Snapshot().AuthorityEnvelope["cwd"]!.GetValue<string>()
        );
        Assert.False(Directory.Exists(raw["cwd"]!.GetValue<string>()));
        Assert.Equal(raw.ToJsonString(), await File.ReadAllTextAsync(file));
    }
}
