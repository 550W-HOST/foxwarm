using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class MainNativePathTests
{
    private static ResponsesClientOptions Options =>
        new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);

    private static JsonObject Call(string name, JsonObject args) =>
        new()
        {
            ["id"] = Guid.NewGuid().ToString("N"),
            ["name"] = name,
            ["args"] = args,
        };

    private static SessionManager Manager(string data, string work) =>
        new(data, work, Options, HostModels.ForTest(Options));

    private static async Task<(SessionToolExecutor Tools, Foxwarm.McpClient Mcp)> Tools(
        SessionManager manager,
        SessionOwner owner,
        string data,
        string work
    )
    {
        var mcp = new Foxwarm.McpClient(data);
        var definitions = WorkspaceTools.Definitions();
        foreach (var entry in LocalExecManager.Definitions())
            definitions.Add(entry!.DeepClone());
        var registry = SessionToolExecutor.CreateRegistry(definitions, mcp, _ => work);
        var tools = new SessionToolExecutor(new WorkspaceTools(work), owner, manager, registry);
        tools.BeginTurn();
        return await Task.FromResult((tools, mcp));
    }

    [Fact]
    public void Source_file_and_exec_default_chains_and_exact_tokens_are_distinct_without_io()
    {
        using var temp = new TempDirectory();
        var agent = Path.Combine(temp.Path, "agent");
        var process = Path.Combine(temp.Path, "process");
        var home = Path.Combine(temp.Path, "home");
        var paths = new MainNativePaths(agent, "a", process, home);
        Assert.Equal(Path.Combine(process, "a", "note"), paths.FilePath("note"));
        Assert.Equal(Path.Combine(process, "a", "a"), paths.ExecCwd(null));
        Assert.Equal(Path.Combine(process, "a", "child"), paths.ExecCwd("child"));
        Assert.Equal(Path.Combine(home, "note"), paths.FilePath("~/note"));
        paths = paths with { SessionCwd = "$fw_tmp" };
        Assert.Equal(Path.Combine(process, "$fw_tmp", "note"), paths.FilePath("note"));
        Assert.Equal(Path.Combine(agent, "tmp", "child"), paths.ExecCwd("child"));
        Assert.Equal(Path.Combine(agent, "tmp", "note"), paths.FilePath("$fw_tmp/note"));
        Assert.Equal(Path.Combine(agent, "tmp", "$fw_tmp"), paths.ExecCwd(" $fw_tmp "));
        Assert.Equal(Path.Combine(agent, "note"), paths.FilePath("$fw_agentdir//note"));
        Assert.Equal(Path.Combine(process, "$fw_tmp", "$HOME"), paths.FilePath("./$HOME"));
        Assert.Throws<ArgumentException>(() => paths.FilePath("$HOME/note"));
        Assert.Throws<ArgumentException>(() => paths.ExecCwd("$other"));
        Assert.False(Directory.Exists(agent));
        Assert.False(Directory.Exists(home));
    }

    [Fact]
    public async Task Native_absolute_tokens_spaces_and_symlink_content_writes_keep_target_bytes_and_report_only_successful_real_paths()
    {
        using var temp = new TempDirectory();
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var files = new WorkspaceTools(work);
        var actual = Path.Combine(temp.Path, "actual");
        Directory.CreateDirectory(actual);
        Directory.CreateSymbolicLink(Path.Combine(work, "link"), actual);
        var target = Path.Combine(actual, "note");
        await File.WriteAllTextAsync(target, "one\n");
        File.CreateSymbolicLink(Path.Combine(work, "leaf"), target);
        JsonArray? metadata = null;
        files.ResolvedPaths = value => metadata = (JsonArray)value.DeepClone();
        var changed = await files.ExecuteAsync(
            Call(
                "write",
                new JsonObject
                {
                    ["filePath"] = "$fw_agentdir/leaf",
                    ["content"] = "two\n",
                    ["overwrite"] = true,
                }
            ),
            default
        );
        Assert.Null(changed["error"]);
        Assert.Equal("two\n", await File.ReadAllTextAsync(target));
        Assert.NotNull(new FileInfo(Path.Combine(work, "leaf")).LinkTarget);
        Assert.Equal(Path.Combine(work, "leaf"), metadata![0]!["resolved"]!.GetValue<string>());
        Assert.Equal("master", metadata[0]!["nodeId"]!.GetValue<string>());
        var edit = await files.ExecuteAsync(
            Call(
                "edit",
                new JsonObject
                {
                    ["filePath"] = Path.Combine(work, "leaf"),
                    ["oldText"] = "two",
                    ["newText"] = "three",
                }
            ),
            default
        );
        Assert.Null(edit["error"]);
        Assert.Equal("three\n", await File.ReadAllTextAsync(target));
        Assert.NotNull(new FileInfo(Path.Combine(work, "leaf")).LinkTarget);
        var spaced = " note ";
        await files.ExecuteAsync(
            Call("write", new JsonObject { ["filePath"] = spaced, ["content"] = "literal" }),
            default
        );
        Assert.True(File.Exists(Path.Combine(work, spaced)));
        Assert.False(File.Exists(Path.Combine(work, "note")));
        metadata = null;
        var partial = await files.ExecuteAsync(
            Call(
                "apply_patch",
                new JsonObject
                {
                    ["input"] =
                        "*** Begin Patch\n*** Add File: link/added\n+added\n*** Update File: missing\n-old\n+new\n*** End Patch",
                }
            ),
            default
        );
        Assert.NotNull(partial["error"]);
        Assert.Contains("Operations already applied", partial["error"]!.ToJsonString());
        Assert.Null(metadata);
        Assert.Equal("added", await File.ReadAllTextAsync(Path.Combine(actual, "added")));
        await files.ExecuteAsync(
            Call(
                "apply_patch",
                new JsonObject
                {
                    ["input"] = "*** Begin Patch\n*** Delete File: leaf\n*** End Patch",
                }
            ),
            default
        );
        Assert.Null(new FileInfo(Path.Combine(work, "leaf")).LinkTarget);
        Assert.True(File.Exists(target));
        Assert.Equal("leaf", metadata![0]!["raw"]!.GetValue<string>());
        Assert.Equal(Path.Combine(work, "leaf"), metadata[0]!["resolved"]!.GetValue<string>());
    }

    [Fact]
    public async Task Actual_input_facts_keep_spaces_exec_token_base_and_prospective_symlink_authorization_aligned_with_effects()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        await using var manager = Manager(data, work);
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "paths", null, null);
        await owner.UpdateCwdAsync("$fw_tmp");
        var files = manager.IdentityWorkspace(owner);
        Assert.Equal(
            Path.Combine(work, "tmp", "child"),
            files.AuthorizationFacts("exec", new JsonObject { ["cwd"] = "child" })[0].Resolved
        );
        Assert.Empty(files.AuthorizationFacts("exec", new JsonObject()));
        var literal = Path.Combine(work, " note ");
        await owner.UpdateCwdAsync(null);
        files = manager.IdentityWorkspace(owner);
        Assert.Equal(
            literal,
            files
                .AuthorizationFacts("write", new JsonObject { ["filePath"] = " note " })[0]
                .Resolved
        );
        var outside = Path.Combine(temp.Path, "outside");
        Directory.CreateDirectory(outside);
        Directory.CreateSymbolicLink(Path.Combine(work, "link"), outside);
        var (tools, mcp) = await Tools(manager, owner, data, work);
        await using var cleanup = mcp;
        await manager.Authorization.InstallAsync(
            Encoding.UTF8.GetBytes(
                "version: 1\ndefaultAction: deny\nrules:\n - id: physical\n   action: allow\n   match:\n     tool: {source: node, name: write}\n     path: {allWithin: '${agent.dir}'}\n"
            ),
            default
        );
        var denied = await tools.ExecuteAttributedAsync(
            Call(
                "write",
                new JsonObject
                {
                    ["filePath"] = "link/new/child",
                    ["content"] = "denied",
                    ["createDirs"] = true,
                }
            ),
            default
        );
        Assert.NotNull(denied.Response!["error"]);
        Assert.False(Directory.Exists(Path.Combine(outside, "new")));
        Assert.Null(denied.ResolvedPaths);
    }

    [Fact]
    public async Task Persisted_cwd_setter_does_not_stat_or_create_and_keeps_cache_snapshot_and_restart_context()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var missing = Path.Combine(temp.Path, "not-created", "nested");
        await using (var manager = Manager(data, work))
        {
            await manager.LoadAsync();
            var owner = await manager.CreateNamedAsync("main", "paths", null, null);
            var before = owner.Entry.Snapshot();
            var change = await owner.UpdateCwdAsync("  " + missing + "  ");
            Assert.True(change["changed"]!.GetValue<bool>());
            Assert.Equal(missing, change["cwd"]!.GetValue<string>());
            Assert.False(Directory.Exists(Path.GetDirectoryName(missing)));
            Assert.True(
                JsonNode.DeepEquals(
                    before.AuthorityEnvelope["promptCacheKey"],
                    owner.Entry.Snapshot().AuthorityEnvelope["promptCacheKey"]
                )
            );
            Assert.True(
                JsonNode.DeepEquals(
                    before.AuthorityEnvelope["persistentMemorySnapshot"],
                    owner.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]
                )
            );
        }
        await using var restarted = Manager(data, work);
        await restarted.LoadAsync();
        var current = await restarted.RequiredAsync("paths");
        Assert.Equal(
            missing,
            current.Entry.Snapshot().AuthorityEnvelope["cwd"]!.GetValue<string>()
        );
        var (tools, mcp) = await Tools(restarted, current, data, work);
        await using var cleanup = mcp;
        var failed = await tools.ExecuteAsync(
            Call("read", new JsonObject { ["filePath"] = "note" }),
            default
        );
        Assert.NotNull(failed!["error"]);
        Assert.False(Directory.Exists(Path.GetDirectoryName(missing)));
        var refused = await tools.ExecuteAsync(
            Call(
                "write",
                new JsonObject { ["filePath"] = "retry.txt", ["content"] = "Owned cached retry." }
            ),
            default
        );
        var reference = System
            .Text.RegularExpressions.Regex.Match(
                refused!["error"]!["message"]!.GetValue<string>(),
                "contentRef: \"([^\"]+)\""
            )
            .Groups[1]
            .Value;
        Assert.NotEmpty(reference);
        Assert.False(Directory.Exists(Path.GetDirectoryName(missing)));
        var cleared = await current.UpdateCwdAsync("\ufeff \t");
        Assert.Null(cleared["cwd"]);
        Assert.Null(current.Entry.Snapshot().AuthorityEnvelope["cwd"]);
        var retry = await tools.ExecuteAttributedAsync(
            Call(
                "write",
                new JsonObject
                {
                    ["filePath"] = "retry.txt",
                    ["contentRef"] = reference,
                    ["overwrite"] = true,
                }
            ),
            default
        );
        Assert.Null(retry.Response!["error"]);
        Assert.Equal(
            "Owned cached retry.",
            await File.ReadAllTextAsync(Path.Combine(work, "retry.txt"))
        );
        Assert.Equal(
            Path.Combine(work, "retry.txt"),
            retry.ResolvedPaths![0]!["resolved"]!.GetValue<string>()
        );
    }

    [Fact]
    public async Task Isolated_Main_cannot_enter_shared_agent_namespace_even_through_a_symlink_but_root_listing_is_not_hidden()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        Directory.CreateDirectory(work);
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "agents.json"),
            "{\"version\":2,\"agents\":[],\"metadata\":{\"main\":{\"isolated\":true}}}"
        );
        await using var manager = Manager(data, work);
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "paths", null, null);
        await File.WriteAllTextAsync(Path.Combine(work, "agents", "00_SYSTEM.md"), "shared");
        Directory.CreateSymbolicLink(Path.Combine(work, "shortcut"), Path.Combine(work, "agents"));
        var (tools, mcp) = await Tools(manager, owner, data, work);
        await using var cleanup = mcp;
        foreach (
            var path in new[]
            {
                "agents/00_SYSTEM.md",
                "shortcut/00_SYSTEM.md",
                "$fw_agentdir/agents/00_SYSTEM.md",
            }
        )
            Assert.NotNull(
                (
                    await tools.ExecuteAsync(
                        Call("read", new JsonObject { ["filePath"] = path }),
                        default
                    )
                )!["error"]
            );
        Assert.Null(
            (
                await tools.ExecuteAsync(
                    Call("read", new JsonObject { ["filePath"] = "." }),
                    default
                )
            )!["error"]
        );
    }

    [Fact]
    public void Display_metadata_is_removed_from_request_history_without_changing_owned_canonical_data()
    {
        var history = new JsonObject
        {
            ["role"] = "tool",
            ["parts"] = new JsonArray(
                new JsonObject
                {
                    ["functionResponse"] = new JsonObject
                    {
                        ["tool_use_id"] = "id",
                        ["name"] = "read",
                        ["response"] = new JsonObject { ["output"] = "text" },
                        ["__meta"] = new JsonObject
                        {
                            ["resolvedPaths"] = new JsonArray(
                                new JsonObject
                                {
                                    ["raw"] = "note",
                                    ["resolved"] = "/synthetic/note",
                                    ["nodeId"] = "master",
                                }
                            ),
                        },
                    },
                }
            ),
        };
        var request = ConcreteRequestHistory.Prepare([history], "wire");
        Assert.Null(request[0]["parts"]![0]!["functionResponse"]!["__meta"]);
        Assert.NotNull(history["parts"]![0]!["functionResponse"]!["__meta"]);
    }
}
