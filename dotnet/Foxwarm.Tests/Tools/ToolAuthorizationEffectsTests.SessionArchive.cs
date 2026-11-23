using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class ToolAuthorizationEffectsTests
{
    private static async Task<JsonObject> SessionArchive(SessionToolExecutor tools, string arguments) =>
        await Call(tools, "ctl", new JsonObject { ["command"] = "session " + arguments });

    [Fact]
    public async Task Session_archive_sets_only_the_catalog_flag_and_is_session_control_archive()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = Executor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        bool Archived(string id) => SessionCatalog.Flag(manager.Catalog.Get(id)?["archived"]);

        // Addressed by alias, positionally or as --session-id; the runtime state is untouched.
        var direct = await manager.RequiredAsync("direct");
        var history = direct.History().Count;
        Assert.Null(ToolFailure.Message(await SessionArchive(execution.Tools, "archive kid")));
        Assert.True(Archived("direct"));
        Assert.Equal(history, direct.History().Count);
        Assert.Null(direct.WaitSnapshot());
        Assert.True(SessionWait.Text((await SessionArchive(execution.Tools, "archive --session-id direct"))["output"])!.Contains("already"));
        Assert.Null(ToolFailure.Message(await SessionArchive(execution.Tools, "unarchive --session-id kid")));
        Assert.False(Archived("direct"));
        // Without a target it archives this Session.
        Assert.Null(ToolFailure.Message(await SessionArchive(execution.Tools, "archive")));
        Assert.True(Archived("opaque"));
        Assert.Null(ToolFailure.Message(await SessionArchive(execution.Tools, "unarchive")));
        Assert.NotNull(ToolFailure.Message(await SessionArchive(execution.Tools, "archive missing-session")));

        // The same operation as renaming, with its own change value.
        await Policy(
            manager,
            "version: 1\ndefaultAction: allow\nrules:\n- {id: no-archive, op: session.control, with: {change: archive}, targetSession: {id: [direct]}, action: deny}\n"
        );
        var denied = await SessionArchive(execution.Tools, "archive kid");
        Assert.Equal("tool_authorization_denied", ToolFailure.Code(denied));
        Assert.False(Archived("direct"));
        Assert.Null(ToolFailure.Message(await Call(execution.Tools, "ctl", new JsonObject { ["command"] = "session rename x --session-id direct" })));
        Assert.Null(ToolFailure.Message(await SessionArchive(execution.Tools, "archive")));
        await Policy(
            manager,
            "version: 1\ndefaultAction: allow\nrules:\n- {id: no-control, op: session.control, targetSession: {id: [direct]}, action: deny}\n"
        );
        Assert.Equal("tool_authorization_denied", ToolFailure.Code(await SessionArchive(execution.Tools, "unarchive kid")));
        Assert.Equal(
            "tool_authorization_denied",
            ToolFailure.Code(await Call(execution.Tools, "ctl", new JsonObject { ["command"] = "session rename y --session-id direct" }))
        );
    }
}
