using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// The operator ceiling layer (OperatorCeiling) over the file stores: a ceiling source stands in
// for the tenant's operator_documents row.
public sealed partial class ToolAuthorizationEffectsTests
{
    private sealed class CeilingSource(string? text) : IOperatorCeilingSource
    {
        internal string? Text { get; set; } = text;
        internal int Reads { get; private set; }

        public OperatorCeilingDocument? Read()
        {
            Reads++;
            return Text is null ? null : new("profile:hosted", Text);
        }
    }

    private const string AllowExecPolicy = """
        version: 1
        defaultAction: deny
        rules:
          - id: tenant-exec
            tool: {source: node, name: exec}
            action: allow
          - id: tenant-read
            tool: {source: node, name: read}
            action: ask
            approval: {timeoutSeconds: 900, approvers: [ops, dev]}
          - id: tenant-sessions
            externalId: alpha
            tool: {source: builtin, name: session}
            action: allow
        """;

    private const string Ceiling = """
        version: 1
        rules:
          - id: no-rm
            tool: {source: node, name: exec}
            args: {command: {equals: rm}}
            action: deny
            reason: The operator doesn't allow rm.
          - id: confirm-read
            tool: {source: node, name: read}
            action: ask
            approval: {timeoutSeconds: 600, approvers: [ops]}
          - id: confirm-ls
            tool: {source: node, name: exec}
            args: {command: {equals: ls}}
            action: ask
        """;

    private static ResolvedTool Read(string path) =>
        new("read", "node", "read", new JsonObject { ["filePath"] = path });

    [Fact]
    public async Task A_ceiling_deny_wins_over_a_tenant_allow_and_explain_names_the_ceiling_rule()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var caller = await manager.RequiredAsync("foreign");
        var execution = Executor(manager, caller, temp.Path);
        await using var mcp = execution.Mcp;
        // Explain needs its own grant and a read of the policy, so this tenant allows by default.
        await Policy(
            manager,
            "version: 1\ndefaultAction: allow\nrules:\n  - id: tenant-exec\n    tool: {source: node, name: exec}\n    action: allow\n"
        );
        manager.Authorization.CeilingSource = new CeilingSource(
            Ceiling[..Ceiling.IndexOf("  - id: confirm-read", StringComparison.Ordinal)]
        );
        manager.Authorization.Invalidate();

        await manager.AuthorizeToolAsync(caller, Exec("true"), execution.Files, CancellationToken.None);
        var denied = await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() =>
            manager.AuthorizeToolAsync(caller, Exec("rm"), execution.Files, CancellationToken.None)
        );
        Assert.IsNotType<ToolApprovalRequiredException>(denied);
        Assert.StartsWith("The operator doesn't allow rm.", denied.Message);
        Assert.Contains("Rule `no-rm` (#1) in the operator ceiling", denied.Message);

        var result = await Explain(
            execution.Tools,
            Obj(
                """
                {"probes":[
                  {"sessionId":"foreign","toolId":"node:master/exec","args":{"command":"rm"}},
                  {"sessionId":"foreign","toolId":"node:master/exec","args":{"command":"true"}}
                ]}
                """
            )
        );
        var rm = result["probes"]![0]!["active"]!;
        Assert.False(rm["allowed"]!.GetValue<bool>());
        Assert.Equal("ceiling", rm["layers"]![0]!["layer"]!.GetValue<string>());
        Assert.Equal("deny", rm["layers"]![0]!["decision"]!.GetValue<string>());
        Assert.Equal("no-rm", rm["layers"]![0]!["rule"]!["id"]!.GetValue<string>());
        Assert.Equal("The operator doesn't allow rm.", rm["layers"]![0]!["rule"]!["reason"]!.GetValue<string>());
        // The tenant's own layer still reports its allow.
        Assert.Equal("global", rm["layers"]![1]!["layer"]!.GetValue<string>());
        Assert.Equal("tenant-exec", rm["layers"]![1]!["rule"]!["id"]!.GetValue<string>());
        // Unmatched by the ceiling: it passes by default and the tenant decides.
        var other = result["probes"]![1]!["active"]!;
        Assert.True(other["allowed"]!.GetValue<bool>());
        Assert.Equal("ceiling", other["layers"]![0]!["layer"]!.GetValue<string>());
        Assert.Null(other["layers"]![0]!["rule"]);
    }

    [Fact]
    public async Task A_ceiling_ask_combines_with_a_tenant_ask_and_asks_over_a_tenant_allow()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var caller = await manager.RequiredAsync("foreign");
        var execution = Executor(manager, caller, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(manager, AllowExecPolicy);
        manager.Authorization.CeilingSource = new CeilingSource(Ceiling);
        manager.Authorization.Invalidate();

        // The tenant allows ls; the ceiling asks.
        var ls = await Assert.ThrowsAsync<ToolApprovalRequiredException>(() =>
            manager.AuthorizeToolAsync(caller, Exec("ls"), execution.Files, CancellationToken.None)
        );
        Assert.Equal(OperatorCeiling.Layer, ls.Assessment.Asking.Single().Layer);
        Assert.Equal("confirm-ls", ls.Assessment.Asking.Single().Decision.Rule!["id"]!.GetValue<string>());

        // Both ask: one approval, with the shorter deadline and only approvers both admit.
        var read = await Assert.ThrowsAsync<ToolApprovalRequiredException>(() =>
            manager.AuthorizeToolAsync(caller, Read("notes.txt"), execution.Files, CancellationToken.None)
        );
        Assert.Equal(
            [OperatorCeiling.Layer, null],
            read.Assessment.Asking.Select(layer => layer.Layer).ToArray()
        );
        Assert.Equal(600, read.Approval.TimeoutSeconds);
        Assert.Equal(["ops"], read.Approval.Approvers);
        // An approval of that exact request passes both.
        var approved = Granted(new ToolApprovalScope(caller), "ap-read", read.Checks.Single().Fingerprint);
        using (ToolApprovalScope.Enter(approved))
            await manager.AuthorizeToolAsync(caller, Read("notes.txt"), execution.Files, CancellationToken.None);
    }

    [Fact]
    public async Task The_ceiling_applies_to_inbound_MCP_principals_and_passes_them_when_unmatched()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        await Policy(manager, AllowExecPolicy);
        var source = new CeilingSource(Ceiling);
        manager.Authorization.CeilingSource = source;
        manager.Authorization.Invalidate();
        var access = new AccessConfiguration(InboundMcpFixture.App());
        var context = new McpExternalContext(
            McpExternalPrincipal.Authenticate(access, InboundMcpFixture.Alpha)!
        );
        var external = new McpExternalAuthorization(manager.Authorization, temp.Path);
        var request = external.Request(context, "builtin", "session", new JsonObject { ["action"] = "list" });

        // The ceiling doesn't match: the tenant's allow decides, for the external principal too.
        await external.RequireAsync(context, request, default);
        Assert.True(external.Visible(context, request));

        source.Text = """
            version: 1
            rules:
              - id: no-inbound-sessions
                externalId: alpha
                tool: {source: builtin, name: session}
                action: deny
            """;
        manager.Authorization.OperatorCeilingChanged();
        var error = await Assert.ThrowsAsync<McpInboundSafeException>(() =>
            external.RequireAsync(context, request, default)
        );
        Assert.Equal("Tool action is not permitted.", error.Message);
        Assert.Throws<McpInboundSafeException>(() => external.Require(context, request));
        Assert.False(external.Visible(context, request));

        // A ceiling ask can't be waited for by an external principal: it refuses.
        source.Text = """
            version: 1
            rules:
              - id: ask-sessions
                tool: {source: builtin, name: session}
                action: ask
            """;
        manager.Authorization.OperatorCeilingChanged();
        await Assert.ThrowsAsync<McpInboundSafeException>(() => external.RequireAsync(context, request, default));
    }

    [Fact]
    public async Task A_ceiling_change_applies_only_after_invalidation_and_a_bad_ceiling_fails_closed()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var caller = await manager.RequiredAsync("foreign");
        var execution = Executor(manager, caller, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(manager, AllowExecPolicy);
        var source = new CeilingSource(null);
        manager.Authorization.CeilingSource = source;
        manager.Authorization.Invalidate();

        // No document: no ceiling layer at all.
        await manager.AuthorizeToolAsync(caller, Exec("rm"), execution.Files, CancellationToken.None);
        var reads = source.Reads;
        source.Text = Ceiling;
        // Cached until the change signal; checks don't read the source again.
        await manager.AuthorizeToolAsync(caller, Exec("rm"), execution.Files, CancellationToken.None);
        Assert.Equal(reads, source.Reads);
        manager.Authorization.OperatorCeilingChanged();
        await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() =>
            manager.AuthorizeToolAsync(caller, Exec("rm"), execution.Files, CancellationToken.None)
        );
        // A tenant policy installation reads the ceiling again as well.
        source.Text = null;
        await Policy(manager, AllowExecPolicy);
        await manager.AuthorizeToolAsync(caller, Exec("rm"), execution.Files, CancellationToken.None);

        // A stored ceiling with an allow rule is refused; every check then fails closed.
        source.Text = """
            version: 1
            rules:
              - id: sneaky
                tool: {source: node, name: exec}
                action: allow
            """;
        manager.Authorization.OperatorCeilingChanged();
        await Assert.ThrowsAsync<ToolAuthorizationUnavailableException>(() =>
            manager.AuthorizeToolAsync(caller, Exec("true"), execution.Files, CancellationToken.None)
        );
    }

    [Fact]
    public void A_ceiling_document_may_only_deny_or_ask()
    {
        var parsed = OperatorCeiling.Parse(Ceiling);
        Assert.True(parsed.PassesByDefault);
        Assert.Equal(3, parsed.Value["rules"]!.AsArray().Count);
        var allow = Assert.Throws<InvalidDataException>(() =>
            OperatorCeiling.Parse(
                """
                version: 1
                rules:
                  - id: no-rm
                    tool: {source: node, name: exec}
                    action: deny
                  - id: widen
                    tool: {source: node, name: exec}
                    action: allow
                    enabled: false
                """
            )
        );
        Assert.Equal("Operator ceiling rule `widen` allows; a ceiling rule may only deny or ask.", allow.Message);
        // Without an id the position names the rule.
        Assert.Contains(
            "`rule-1`",
            Assert.Throws<InvalidDataException>(() =>
                OperatorCeiling.Parse("version: 1\nrules:\n  - tool: {source: node, name: exec}\n    action: allow\n")
            ).Message
        );
        foreach (var action in new[] { "deny", "ask" })
            Assert.Throws<InvalidDataException>(() =>
                OperatorCeiling.Parse($"version: 1\ndefaultAction: {action}\nrules: []\n")
            );
        // The version-1 grammar still applies.
        Assert.Throws<InvalidDataException>(() => OperatorCeiling.Parse("version: 2\nrules: []\n"));
        Assert.Empty(OperatorCeiling.Parse("version: 1\n").Value["rules"]!.AsArray());
    }

    [Fact]
    public async Task A_ceiling_deny_hides_the_tool_from_discovery()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var caller = await manager.RequiredAsync("foreign");
        await Policy(manager, "version: 1\ndefaultAction: allow\n");
        Assert.True(manager.ToolVisible(caller, "builtin", "create_timer"));
        manager.Authorization.CeilingSource = new CeilingSource(
            "version: 1\nrules:\n  - id: no-timers\n    tool: {source: builtin, name: create_timer}\n    action: deny\n"
        );
        manager.Authorization.OperatorCeilingChanged();
        Assert.False(manager.ToolVisible(caller, "builtin", "create_timer"));
    }
}
