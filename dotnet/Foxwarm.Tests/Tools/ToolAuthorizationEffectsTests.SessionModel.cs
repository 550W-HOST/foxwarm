using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class ToolAuthorizationEffectsTests
{
    private static async Task<JsonObject> SessionModel(
        SessionToolExecutor tools,
        string arguments
    ) => await Call(tools, "ctl", new JsonObject { ["command"] = "session model" + arguments });

    [Fact]
    public async Task Session_model_switches_this_Session_or_a_descendant_and_is_session_control_settings()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = Executor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;

        // Inspecting shows the selection and the configured models.
        var shown = await SessionModel(execution.Tools, "");
        Assert.Null(ToolFailure.Message(shown));
        Assert.Equal("opaque", SessionWait.Text(shown["sessionId"]));
        var key = SessionWait.Text(shown["models"]![0])!;
        var effort = SessionWait.Text(shown["allowedEfforts"]!.AsArray().Last())!;

        // A descendant Session, addressed by alias, is switched.
        var child = await SessionModel(execution.Tools, $" {key} --session-id kid --effort {effort}");
        Assert.Null(ToolFailure.Message(child));
        Assert.Equal("direct", SessionWait.Text(child["sessionId"]));
        Assert.Equal(key, SessionWait.Text(child["modelOverride"]));
        Assert.False(child.ContainsKey("models"));
        var direct = await manager.RequiredAsync("direct");
        Assert.Equal(key, direct.Metadata().Model);
        Assert.Equal(effort, direct.Metadata().Effort);

        // default and unset clear the overrides again.
        var cleared = await SessionModel(execution.Tools, " default --session-id direct --effort unset");
        Assert.Null(ToolFailure.Message(cleared));
        Assert.Null(direct.Metadata().Model);
        Assert.Null(direct.Metadata().Effort);

        // A Session outside the caller's subtree is refused before any change.
        var foreign = await SessionModel(execution.Tools, $" {key} --session-id foreign");
        Assert.Contains("not this Session or one of its descendants", ToolFailure.Message(foreign));
        Assert.Null((await manager.RequiredAsync("foreign")).Metadata().Model);

        // A child cannot switch its parent.
        var childExecution = Executor(manager, direct, temp.Path);
        await using var childMcp = childExecution.Mcp;
        var parent = await SessionModel(childExecution.Tools, $" {key} --session-id opaque");
        Assert.Contains("not this Session or one of its descendants", ToolFailure.Message(parent));

        // Policy narrows further through session.control settings of the target.
        await Policy(
            manager,
            "version: 1\ndefaultAction: allow\nrules:\n- {id: no-settings, op: session.control, with: {change: settings}, targetSession: {id: [opaque]}, action: deny}\n"
        );
        var denied = await SessionModel(execution.Tools, $" {key}");
        Assert.Equal("tool_authorization_denied", ToolFailure.Code(denied));
        Assert.Null(owner.Metadata().Model);
        Assert.Null(ToolFailure.Message(await SessionModel(execution.Tools, $" {key} --session-id direct")));
    }
}
