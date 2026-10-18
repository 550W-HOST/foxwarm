using System.Text.Json.Nodes;
using Foxwarm.Nodes;

namespace Foxwarm.Tests;

public sealed class ExternalExecOwnershipTests
{
    [Fact]
    public async Task Bounded_records_keep_original_arguments_signed_owner_and_all_used_Nodes_beyond_eviction()
    {
        await using var f = await InboundMcpFixture.CreateAsync();
        var context = new McpExternalContext(
            McpExternalPrincipal.Authenticate(f.Configuration.Access, InboundMcpFixture.Alpha)!
        );
        var other = new McpExternalContext(
            McpExternalPrincipal.Authenticate(f.Configuration.Access, InboundMcpFixture.Alpha)!
        );
        var ownership = f.Manager.Nodes.ExternalExec;
        var args = new JsonObject { ["command"] = "original", ["cwd"] = "/original" };
        var original = ownership.Reserve(context, "first", args, -1);
        args["command"] = "changed";
        Assert.Equal("original", original.Args["command"]!.GetValue<string>());
        Assert.False(
            ownership.Background("first", other.WireOwner(), original.Id, original.Capability)
        );
        Assert.False(
            ownership.Complete(
                "second",
                context.WireOwner(),
                original.Id,
                original.Capability,
                "forged",
                null
            )
        );
        Assert.False(
            ownership.Complete(
                "first",
                context.WireOwner(),
                original.Id,
                original.Capability + "x",
                "forged",
                null
            )
        );
        Assert.True(
            ownership.Background("first", context.WireOwner(), original.Id, original.Capability)
        );
        Assert.False(
            ownership.Complete(
                "first",
                context.WireOwner(),
                original.Id,
                original.Capability,
                new string('é', 128 * 1024 + 1),
                null
            )
        );
        Assert.True(
            ownership.Complete(
                "first",
                context.WireOwner(),
                original.Id,
                original.Capability,
                "actual",
                null
            )
        );
        Assert.True(
            ownership.Complete(
                "first",
                context.WireOwner(),
                original.Id,
                original.Capability,
                "actual",
                null
            )
        );
        Assert.False(
            ownership.Complete(
                "first",
                context.WireOwner(),
                original.Id,
                original.Capability,
                "different",
                null
            )
        );
        for (var i = 0; i < 21; i++)
        {
            var record = ownership.Reserve(
                context,
                "second",
                new JsonObject { ["command"] = "completed-" + i },
                -1
            );
            Assert.True(
                ownership.Complete(
                    "second",
                    context.WireOwner(),
                    record.Id,
                    record.Capability,
                    "done",
                    null
                )
            );
        }
        Assert.Equal(20, ownership.List(context, 20).Length);
        Assert.Null(ownership.Get(context, original.Id));
        Assert.All(ownership.List(context, 20), record => Assert.Equal("second", record.Node));
        var used = context.Fence();
        Assert.Equal(new[] { "first", "second" }, used.Order());
        await f.Manager.Nodes.ReleaseExternalAsync(context, used);
        Assert.Empty(ownership.List(context, 20));
        Assert.False(
            ownership.Complete(
                "first",
                context.WireOwner(),
                original.Id,
                original.Capability,
                "actual",
                null
            )
        );
        other.Fence();
        other.Lifetime.Dispose();
        context.Lifetime.Dispose();
    }

    [Fact]
    public async Task Active_saturation_and_argument_bounds_fail_before_dispatch_and_result_access_reauthorizes_original_args()
    {
        await using var f = await InboundMcpFixture.CreateAsync();
        var context = new McpExternalContext(
            McpExternalPrincipal.Authenticate(f.Configuration.Access, InboundMcpFixture.Alpha)!
        );
        var ownership = f.Manager.Nodes.ExternalExec;
        Assert.Throws<McpInboundSafeException>(() =>
            ownership.Reserve(
                context,
                "node",
                new JsonObject { ["command"] = new string('é', 32768) },
                -1
            )
        );
        for (var i = 0; i < 20; i++)
            ownership.Reserve(context, "node", new JsonObject { ["command"] = "allowed-" + i }, -1);
        Assert.Throws<McpInboundSafeException>(() =>
            ownership.Reserve(context, "node", new JsonObject { ["command"] = "overflow" }, -1)
        );
        var selected = ownership.List(context, 20)[0];
        Assert.True(
            ownership.Complete(
                "node",
                context.WireOwner(),
                selected.Id,
                selected.Capability,
                "retained",
                null
            )
        );
        var service = new McpInboundNodes(f.Manager.Nodes, new(f.Manager.Authorization, f.Work));
        Assert.Equal(
            "retained",
            (await service.ResultAsync(context, selected.Id, 5, default))[
                "output"
            ]!.GetValue<string>()
        );
        await f.PolicyAsync(
            "version: 1\nrules:\n  - id: deny-original\n    action: deny\n    match:\n      externalId: alpha\n      tool: {source: node, name: exec}\n      args: {command: '"
                + selected.Args["command"]!.GetValue<string>()
                + "'}\n  - id: others\n    action: allow\n    match: {externalId: alpha}\n"
        );
        await Assert.ThrowsAsync<McpInboundSafeException>(() =>
            service.ResultAsync(context, selected.Id, 5, default)
        );
        var listed = await service.ResultAsync(context, null, 20, default);
        Assert.DoesNotContain(
            listed["executions"]!.AsArray(),
            row => row!["execId"]!.GetValue<string>() == selected.Id
        );
        var used = context.Fence();
        await f.Manager.Nodes.ReleaseExternalAsync(context, used);
        context.Lifetime.Dispose();
    }

    [Fact]
    public async Task Completion_cwd_uses_the_dispatch_selection_generation_not_a_successor_selection()
    {
        await using var f = await InboundMcpFixture.CreateAsync();
        var context = new McpExternalContext(
            McpExternalPrincipal.Authenticate(f.Configuration.Access, InboundMcpFixture.Alpha)!
        );
        context.Select("first", "/first");
        var snapshot = context.Selection;
        var record = f.Manager.Nodes.ExternalExec.Reserve(
            context,
            "first",
            new JsonObject { ["command"] = "delayed" },
            snapshot.Generation
        );
        context.Select("second", "/second");
        Assert.True(
            f.Manager.Nodes.ExternalExec.Complete(
                "first",
                context.WireOwner(),
                record.Id,
                record.Capability,
                "done",
                "/old-cwd"
            )
        );
        Assert.Equal(("second", "/second", snapshot.Generation + 1), context.Selection);
        var used = context.Fence();
        await f.Manager.Nodes.ReleaseExternalAsync(context, used);
        context.Lifetime.Dispose();
    }
}
