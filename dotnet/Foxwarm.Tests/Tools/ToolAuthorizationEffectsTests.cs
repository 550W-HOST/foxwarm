using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class ToolAuthorizationEffectsTests
{
    private static ResponsesClientOptions Options =>
        new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);

    private static JsonObject Obj(string value) => JsonNode.Parse(value)!.AsObject();

    private static async Task Seed(string root, JsonObject? isolation = null)
    {
        var data = Path.Combine(root, "data");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "agents.json"),
            new JsonObject
            {
                ["version"] = 2,
                ["agents"] = new JsonArray("alpha", "beta"),
                ["metadata"] = new JsonObject { ["alpha"] = isolation ?? new() },
            }.ToJsonString()
        );
        foreach (var agent in new[] { "alpha", "beta" })
            Directory.CreateDirectory(Path.Combine(root, "workspace", "agents", agent, "memory"));
        using var catalog = new SessionCatalog(data);
        catalog.Initialize();
        foreach (
            var (id, agent, parent, aliases) in new[]
            {
                ("opaque", "alpha", (string?)null, new[] { "self" }),
                ("direct", "alpha", "opaque", new[] { "kid" }),
                ("foreign", "beta", (string?)null, new[] { "outside" }),
            }
        )
        {
            await SessionCatalogMigrationTests.Authority(data, id);
            var file = Path.Combine(data, "state", "sessions", id + ".json");
            var state = JsonNode.Parse(await File.ReadAllTextAsync(file))!.AsObject();
            state["agent"] = agent;
            await File.WriteAllTextAsync(file, state.ToJsonString());
            catalog.Upsert([SessionCatalogTests.Row(id, 0, parent, agent, aliases)]);
        }
    }

    private static SessionManager Manager(string root) =>
        new(
            Path.Combine(root, "data"),
            Path.Combine(root, "workspace"),
            Options,
            HostModels.ForTest(Options)
        );

    private static async Task Policy(SessionManager manager, string text) =>
        await manager.Authorization.InstallAsync(
            Encoding.UTF8.GetBytes(text),
            CancellationToken.None
        );

    private static (
        SessionToolExecutor Tools,
        WorkspaceTools Files,
        Foxwarm.McpClient Mcp,
        ToolRegistry Registry
    ) Executor(SessionManager manager, SessionOwner owner, string root)
    {
        var files = new WorkspaceTools(
            Path.Combine(root, "workspace", "agents", owner.Agent),
            new PendingWriteRefs(),
            owner.Id,
            owner.Agent
        );
        var definitions = WorkspaceTools.Definitions();
        foreach (var definition in AgentToolDefinitions.Definitions())
            definitions.Add(definition.DeepClone());
        foreach (var definition in ObservationToolDefinitions.Definitions())
            definitions.Add(definition.DeepClone());
        foreach (var definition in KnowledgeToolDefinitions.Definitions())
            definitions.Add(definition.DeepClone());
        foreach (var definition in UnifiedToolDefinitions.All())
            definitions.Add(definition?.DeepClone());
        definitions.Add(ToolAuthorizationToolDefinition.Definition());
        foreach (var definition in LocalExecManager.Definitions())
            definitions.Add(definition?.DeepClone());
        definitions.Add(ArchiveRecallTool.Definition());
        foreach (var definition in ToolScriptToolDefinitions.Definitions())
            definitions.Add(definition?.DeepClone());
        foreach (var definition in FileDeliveryDefinitions.Definitions())
            definitions.Add(definition?.DeepClone());
        definitions.Add(CompactToolDefinition.Definition());
        foreach (var definition in SessionSettingsDefinitions.Definitions())
            definitions.Add(definition?.DeepClone());
        var mcp = new Foxwarm.McpClient(Path.Combine(root, "data"));
        var registry = SessionToolExecutor.CreateRegistry(
            definitions,
            mcp,
            _ => Path.Combine(root, "workspace", "agents", owner.Agent)
        );
        var tools = new SessionToolExecutor(files, owner, manager, registry);
        tools.BeginTurn();
        return (tools, files, mcp, registry);
    }

    private static async Task<JsonObject> Call(
        SessionToolExecutor tools,
        string name,
        JsonObject args
    ) =>
        (
            await tools.ExecuteAsync(
                new JsonObject
                {
                    ["id"] = Guid.NewGuid().ToString("N"),
                    ["name"] = name,
                    ["args"] = args,
                },
                CancellationToken.None
            )
        )!.AsObject();

    private static string? Error(JsonObject response) =>
        response["error"]?["type"]?.GetValue<string>();

    [Fact]
    public async Task Loader_root_cache_expiration_fresh_async_retry_sync_unavailable_and_exact_missing_are_not_stale_allow()
    {
        using var temp = new TempDirectory();
        var now = 0L;
        var attempts = 0;
        var file = Path.Combine(temp.Path, "state", "tool-authorization.yaml");
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var authority = new ToolAuthorizationAuthority(
            temp.Path,
            () => now,
            _ =>
            {
                attempts++;
                File.WriteAllText(file, "version: 1\ndefaultAction: allow");
                return Task.CompletedTask;
            }
        );
        Assert.Equal("allow", authority.Load().Value["defaultAction"]!.GetValue<string>());
        await File.WriteAllTextAsync(file, "version: 1\ndefaultAction: deny");
        now = 9999;
        Assert.Equal("allow", authority.Load().Value["defaultAction"]!.GetValue<string>());
        now = 10_000;
        Assert.Equal("deny", authority.Load().Value["defaultAction"]!.GetValue<string>());
        await File.WriteAllTextAsync(file, "bad");
        now = 20_000;
        Assert.Equal(
            "allow",
            (await authority.LoadAsync()).Value["defaultAction"]!.GetValue<string>()
        );
        Assert.Equal(1, attempts);
        await File.WriteAllTextAsync(file, "version: 1\nrules: null");
        now = 30_000;
        Assert.Throws<ToolAuthorizationUnavailableException>(() => authority.Load());
        File.Delete(file);
        authority.Invalidate();
        Assert.Equal("allow", authority.Load().Value["defaultAction"]!.GetValue<string>());
        Directory.CreateDirectory(file);
        authority.Invalidate();
        Assert.Throws<ToolAuthorizationUnavailableException>(() => authority.Load());
        Directory.Delete(file);
        Directory.Delete(Path.GetDirectoryName(file)!);
        await File.WriteAllTextAsync(Path.GetDirectoryName(file)!, "not a directory");
        authority.Invalidate();
        Assert.Throws<ToolAuthorizationUnavailableException>(() => authority.Load());
        var other = new ToolAuthorizationAuthority(Path.Combine(temp.Path, "other"));
        Assert.Equal("allow", other.Load().Value["defaultAction"]!.GetValue<string>());
    }

    [Fact]
    public async Task Physical_paths_from_real_resolvers_cover_contentRef_every_new_destination_patch_all_headers_and_default_schema_projection()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = Executor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        var own = Path.Combine(temp.Path, "workspace", "agents", "alpha");
        Directory.CreateDirectory(Path.Combine(own, "allowed"));
        Directory.CreateDirectory(Path.Combine(own, "forbidden"));
        await File.WriteAllTextAsync(Path.Combine(own, "allowed", "exists"), "old");
        await File.WriteAllTextAsync(Path.Combine(own, "forbidden", "second"), "untouched");
        await Policy(
            manager,
            "version: 1\nrules:\n- id: exec\n  action: deny\n  match: {tool: {source: node, name: exec}}\n- id: paths\n  action: deny\n  match: {tool: {source: node, name: [write, edit, apply_patch]}, path: {anyNotWithin: '${agent.dir}/allowed'}}"
        );
        var definitions = manager.ModelDefinitions(owner);
        Assert.DoesNotContain(definitions, node => node?["name"]?.GetValue<string>() == "exec");
        Assert.Contains(definitions, node => node?["name"]?.GetValue<string>() == "write");
        Assert.Contains(definitions, node => node?["name"]?.GetValue<string>() == "call_tool");
        Assert.DoesNotContain(
            definitions,
            node => node?["name"]?.GetValue<string>() == "set_config"
        );
        var refused = await Call(
            execution.Tools,
            "write",
            Obj("""{"filePath":"allowed/exists","content":"new"}""")
        );
        var reference = Regex
            .Match(
                refused["error"]!["message"]!.GetValue<string>(),
                "contentRef: \"(write_[a-f0-9]+)\""
            )
            .Groups[1]
            .Value;
        Assert.NotEmpty(reference);
        var denied = await Call(
            execution.Tools,
            "call_tool",
            new JsonObject
            {
                ["source"] = "node",
                ["name"] = "write",
                ["nodeId"] = "master",
                ["args"] = new JsonObject
                {
                    ["filePath"] = "forbidden/new",
                    ["contentRef"] = reference,
                    ["overwrite"] = true,
                },
            }
        );
        Assert.Equal("tool_authorization_denied", Error(denied));
        Assert.False(File.Exists(Path.Combine(own, "forbidden", "new")));
        var reused = await Call(
            execution.Tools,
            "write",
            new JsonObject
            {
                ["filePath"] = "allowed/new",
                ["contentRef"] = reference,
                ["overwrite"] = true,
            }
        );
        Assert.Null(Error(reused));
        Assert.Equal("new", await File.ReadAllTextAsync(Path.Combine(own, "allowed", "new")));
        var patch =
            "*** Begin Patch\n*** Update File: allowed/exists\n@@\n-old\n+changed\n*** Update File: forbidden/second\n@@\n-untouched\n+changed\n*** End Patch";
        Assert.Equal(
            "tool_authorization_denied",
            Error(await Call(execution.Tools, "apply_patch", new JsonObject { ["input"] = patch }))
        );
        Assert.Equal("old", await File.ReadAllTextAsync(Path.Combine(own, "allowed", "exists")));
        Assert.Equal(
            "untouched",
            await File.ReadAllTextAsync(Path.Combine(own, "forbidden", "second"))
        );
        var literal = await Call(
            execution.Tools,
            "write",
            Obj("""{"filePath":"~/literal","content":"x","createDirs":true}""")
        );
        Assert.Equal("tool_authorization_denied", Error(literal));
        var search = await Call(
            execution.Tools,
            "search_tools",
            Obj("""{"sources":["node"],"query":"exec"}""")
        );
        Assert.DoesNotContain("node:master/exec", search["output"]!.GetValue<string>());
        var overrideSchema = new JsonArray(new JsonObject { ["name"] = "exec" });
        Assert.True(
            JsonNode.DeepEquals(overrideSchema, manager.ModelDefinitions(owner, overrideSchema))
        );
        Assert.False(execution.Tools.PolicyUnavailable);
    }

    [Fact]
    public async Task Setter_requires_current_concrete_setter_and_read_permissions_captures_exact_bytes_preserves_failed_replacement_and_invalidates_cache()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = Executor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        var own = Path.Combine(temp.Path, "workspace", "agents", "alpha");
        var candidate = Path.Combine(own, "candidate.yaml");
        var target = Path.Combine(temp.Path, "data", "state", "tool-authorization.yaml");
        var bytes = Encoding.UTF8.GetBytes(
            "# retained comment\r\nversion: 1\r\ndefaultAction: deny\r\n"
        );
        await File.WriteAllBytesAsync(candidate, bytes);
        await Policy(
            manager,
            "version: 1\nrules: [{id: read, action: deny, match: {tool: {source: node, name: read}}}]"
        );
        var original = await File.ReadAllBytesAsync(target);
        var denied = await Call(
            execution.Tools,
            "set_config",
            Obj("""{"target":"tool-rules","filePath":"candidate.yaml"}""")
        );
        Assert.Equal("tool_authorization_denied", Error(denied));
        Assert.Equal(original, await File.ReadAllBytesAsync(target));
        await Policy(manager, "version: 1");
        original = await File.ReadAllBytesAsync(target);
        manager.Authorization.InstallBoundary = stage =>
        {
            if (stage == "before-rename")
                throw new IOException("synthetic rename boundary fault");
        };
        Assert.NotNull(
            Error(
                await Call(
                    execution.Tools,
                    "set_config",
                    Obj("""{"target":"tool-rules","filePath":"candidate.yaml"}""")
                )
            )
        );
        Assert.Equal(original, await File.ReadAllBytesAsync(target));
        Assert.Empty(
            Directory.GetFiles(Path.GetDirectoryName(target)!, ".tool-authorization-*.tmp")
        );
        manager.Authorization.InstallBoundary = stage =>
        {
            if (stage == "captured")
                File.WriteAllText(candidate, "invalid later candidate");
        };
        Assert.Null(
            Error(
                await Call(
                    execution.Tools,
                    "set_config",
                    Obj("""{"target":"tool-rules","filePath":"candidate.yaml"}""")
                )
            )
        );
        Assert.Equal(bytes, await File.ReadAllBytesAsync(target));
        if (!OperatingSystem.IsWindows())
            Assert.Equal(
                UnixFileMode.UserRead | UnixFileMode.UserWrite,
                File.GetUnixFileMode(target)
            );
        Assert.Equal(
            "tool_authorization_denied",
            Error(
                await Call(
                    execution.Tools,
                    "write",
                    Obj("""{"filePath":"after","content":"denied"}""")
                )
            )
        );
        Assert.False(File.Exists(Path.Combine(own, "after")));
        manager.Authorization.InstallBoundary = null;
        await Policy(manager, "version: 1");
        await File.WriteAllTextAsync(candidate, "version: 1\nrules: null");
        original = await File.ReadAllBytesAsync(target);
        Assert.NotNull(
            Error(
                await Call(
                    execution.Tools,
                    "set_config",
                    Obj("""{"target":"tool-rules","filePath":"candidate.yaml"}""")
                )
            )
        );
        Assert.Equal(original, await File.ReadAllBytesAsync(target));
        Assert.False(execution.Tools.PolicyUnavailable);
        File.CreateSymbolicLink(Path.Combine(own, "link"), candidate);
        Assert.NotNull(
            Error(
                await Call(
                    execution.Tools,
                    "set_config",
                    Obj("""{"target":"tool-rules","filePath":"link"}""")
                )
            )
        );
        Assert.Equal(original, await File.ReadAllBytesAsync(target));
    }

    [Fact]
    public async Task Actual_Main_opaque_identity_alias_relation_facts_do_not_hydrate_denied_targets_or_invent_missing_self()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = Executor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(
            manager,
            "version: 1\ndefaultAction: deny\nrules:\n- id: children\n  action: allow\n  match: {tool: {source: builtin, name: send_to_session}, args: {sessionId: {session: {sameAgent: true, relation: child}}}}\n- id: self\n  action: allow\n  match: {tool: {source: builtin, name: recall}, args: {sessionId: {session: {self: true}}}}\n- id: history-self\n  action: allow\n  match: {tool: {source: builtin, name: view_session}, args: {sessionId: {session: {self: true}}}}"
        );
        await manager.AuthorizeToolAsync(
            owner,
            new(
                "send_to_session",
                "builtin",
                "send_to_session",
                Obj("""{"sessionId":"kid","message":"x"}""")
            ),
            null,
            CancellationToken.None
        );
        await manager.AuthorizeToolAsync(
            owner,
            new("recall", "builtin", "recall", new()),
            null,
            CancellationToken.None
        );
        await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() =>
            manager.AuthorizeToolAsync(
                owner,
                new("view_session", "builtin", "view_session", new()),
                null,
                CancellationToken.None
            )
        );
        Assert.Equal(
            "tool_authorization_denied",
            Error(
                await Call(
                    execution.Tools,
                    "send_to_session",
                    Obj("""{"sessionId":"outside","message":"x"}""")
                )
            )
        );
        Assert.Single(manager.Owners());
        var target = await manager.RequiredAsync("direct");
        await manager.AuthorizeToolAsync(
            owner,
            new(
                "send_to_session",
                "builtin",
                "send_to_session",
                Obj("""{"sessionId":"kid","message":"x"}""")
            ),
            null,
            CancellationToken.None,
            target
        );
        manager.Catalog.Upsert([SessionCatalogTests.Row("direct", 0, "foreign", "alpha", ["kid"])]);
        await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() =>
            manager.AuthorizeToolAsync(
                owner,
                new(
                    "send_to_session",
                    "builtin",
                    "send_to_session",
                    Obj("""{"sessionId":"kid","message":"x"}""")
                ),
                null,
                CancellationToken.None,
                target
            )
        );
    }

    [Fact]
    public async Task Isolated_read_old_metadata_exact_allow_is_not_structural_or_handler_permission_and_current_default_status_stays_usable()
    {
        using var temp = new TempDirectory();
        await Seed(
            temp.Path,
            Obj(
                """{"isolated":true,"isolatedNode":"future-node","toolRules":[{"source":"node","node":"master","tool":"exec","effect":"allow"},{"source":"node","node":"master","tool":"read","effect":"allow"},{"source":"builtin","tool":"session","effect":"allow"},{"source":"builtin","tool":"skill","effect":"allow"},{"source":"builtin","tool":"recall","effect":"allow"}]}"""
            )
        );
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = Executor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        Assert.True(manager.AgentIsolated("alpha"));
        Assert.Equal("future-node", manager.RecordedIsolationNode("alpha"));
        Assert.Equal(
            "tool_authorization_denied",
            Error(
                await Call(
                    execution.Tools,
                    "call_tool",
                    Obj(
                        """{"toolId":"node:master/exec","args":{"command":"touch forbidden-exec"}}"""
                    )
                )
            )
        );
        Assert.False(
            File.Exists(Path.Combine(temp.Path, "workspace", "agents", "alpha", "forbidden-exec"))
        );
        var other = Path.Combine(temp.Path, "workspace", "agents", "beta", "other");
        await File.WriteAllTextAsync(other, "other");
        Assert.Equal(
            "tool_authorization_denied",
            Error(
                await Call(
                    execution.Tools,
                    "call_tool",
                    new JsonObject
                    {
                        ["toolId"] = "node:master/read",
                        ["args"] = new JsonObject { ["filePath"] = other },
                    }
                )
            )
        );
        Assert.Equal(
            "tool_authorization_denied",
            Error(await Call(execution.Tools, "session", Obj("""{"action":"list"}""")))
        );
        Assert.Null(Error(await Call(execution.Tools, "session", Obj("""{"action":"status"}"""))));
        Assert.Null(
            Error(
                await Call(
                    execution.Tools,
                    "session",
                    Obj("""{"action":"status","sessionId":"self"}""")
                )
            )
        );
        Assert.Equal(
            "agent_tool_error",
            Error(
                await Call(
                    execution.Tools,
                    "session",
                    Obj("""{"action":"status","sessionId":"kid"}""")
                )
            )
        );
        Assert.Equal(
            "tool_authorization_denied",
            Error(
                await Call(
                    execution.Tools,
                    "skill",
                    Obj("""{"action":"list","agentName":"beta"}""")
                )
            )
        );
        Assert.Equal(
            "tool_authorization_denied",
            Error(await Call(execution.Tools, "recall", Obj("""{"sessionId":"outside"}""")))
        );
        Assert.Single(manager.Owners());
        Assert.Equal(
            "tool_authorization_denied",
            Error(
                await Call(
                    execution.Tools,
                    "view_session",
                    Obj("""{"sessionId":"opaque"}""")
                )
            )
        );
        Assert.DoesNotContain(
            manager.ModelDefinitions(owner),
            node => node?["name"]?.GetValue<string>() == "exec"
        );
        Assert.Contains(
            manager.ModelDefinitions(owner),
            node => node?["name"]?.GetValue<string>() == "session"
        );
    }

    [Fact]
    public async Task Official_SDK_direct_and_neutral_resolved_calls_share_authorization_and_peer_named_read_never_gains_host_path_facts()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        var repository =
            Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")
            ?? throw new InvalidOperationException("Source checkout is required.");
        var peer = Path.Combine(temp.Path, "peer");
        Directory.CreateDirectory(peer);
        await File.WriteAllTextAsync(
            Path.Combine(temp.Path, "data", "state", "mcp.json"),
            new JsonObject
            {
                ["servers"] = new JsonObject
                {
                    ["peer"] = new JsonObject
                    {
                        ["transport"] = "stdio",
                        ["command"] = "node",
                        ["args"] = new JsonArray(
                            Path.Combine(
                                repository,
                                "packages",
                                "webui",
                                "test",
                                "experimentHostAuthorization.peer.mjs"
                            ),
                            peer,
                            Path.Combine(temp.Path, "unused-policy")
                        ),
                        ["timeoutSeconds"] = 3,
                    },
                },
            }.ToJsonString()
        );
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = Executor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(
            manager,
            "version: 1\nrules: [{id: peer, action: deny, match: {tool: {source: mcp, server: peer}}}]"
        );
        var direct = new ResolvedTool(
            "direct-peer",
            "mcp",
            "probe",
            Obj("""{"tag":"direct"}"""),
            "peer"
        );
        await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() =>
            execution.Registry.ExecuteAsync(direct, execution.Tools, CancellationToken.None)
        );
        Assert.Equal(
            "tool_authorization_denied",
            Error(
                await Call(
                    execution.Tools,
                    "call_tool",
                    Obj("""{"toolId":"mcp:peer/probe","args":{"tag":"unified-denied"}}""")
                )
            )
        );
        Assert.False(File.Exists(Path.Combine(peer, "processes.ndjson")));
        await Policy(manager, "version: 1");
        var result = await execution.Registry.ExecuteAsync(
            direct,
            execution.Tools,
            CancellationToken.None
        );
        Assert.True(result!["retained"]!.GetValue<bool>());
        Assert.True(File.Exists(Path.Combine(peer, "effect-direct")));
        Assert.Null(
            Error(
                await Call(
                    execution.Tools,
                    "call_tool",
                    Obj("""{"toolId":"mcp:peer/probe","args":{"tag":"unified"}}""")
                )
            )
        );
        Assert.True(File.Exists(Path.Combine(peer, "effect-unified")));
        var opaque = await execution.Tools.ExecuteAttributedAsync(
            new JsonObject
            {
                ["id"] = "forged-display",
                ["name"] = "call_tool",
                ["args"] = Obj("""{"toolId":"mcp:peer/probe","args":{"kind":"forged-display"}}"""),
            },
            default
        );
        Assert.Null(opaque.ResolvedPaths);
        Assert.NotNull(opaque.Response!["__meta"]?["resolvedPaths"]);
        await Policy(
            manager,
            "version: 1\ndefaultAction: deny\nrules: [{id: physical-only, action: allow, match: {tool: read, path: {allWithin: '${agent.dir}'}}}]"
        );
        Assert.Equal(
            "tool_authorization_denied",
            Error(
                await Call(
                    execution.Tools,
                    "call_tool",
                    Obj(
                        """{"toolId":"mcp:peer/read","args":{"filePath":"owned","tag":"pretend-file"}}"""
                    )
                )
            )
        );
        Assert.False(File.Exists(Path.Combine(peer, "effect-pretend-file")));
        var calls = (await File.ReadAllLinesAsync(Path.Combine(peer, "calls.ndjson")))
            .Select(value => Obj(value))
            .Where(value => value["kind"]?.GetValue<string>() == "call")
            .ToArray();
        Assert.Equal(3, calls.Length);
    }
}
