using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.ToolScript;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

public sealed class ToolScriptNativeExceptionTests
{
    private const string SingleCall = "call_tool('read', {'filePath': 'missing-native-file'})";
    private const string MultilineCall = "call_tool({\n    'source': 'node',\n    'name': 'read',\n    'args': {'filePath': 'missing-native-file'},\n})";

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Native_uncaught_host_exception_keeps_current_error_and_stdout(bool multiline)
    {
        await using var f = await ScriptFixture.Create();
        var failed = await f.Call("run_script", new JsonObject
        {
            ["code"] = "print('before')\nvalue = " + (multiline ? MultilineCall : SingleCall)
                + "\nprint('after')\nreturn value",
        });
        Console.WriteLine(failed.ToJsonString());
        Assert.Equal("failed", SessionWait.Text(failed["status"]));
        Assert.Contains("RuntimeError:", SessionWait.Text(failed["error"]));
        Assert.Contains("not found", SessionWait.Text(failed["error"]), StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("invalid exception payload", SessionWait.Text(failed["error"]));
        Assert.Equal("before\n", SessionWait.Text(failed["stdout"]));
        Assert.Null(failed["lastHostCall"]);
    }

    [Fact]
    public async Task Native_caught_host_exception_does_not_mask_a_later_VM_error()
    {
        await using var f = await ScriptFixture.Create();
        var caught = "try:\n    " + MultilineCall.Replace("\n", "\n    ")
            + "\nexcept RuntimeError as error:\n    print('caught')\n";
        var completed = await f.Call("run_script", new JsonObject
        {
            ["code"] = caught + "return {'false': False, 'zero': 0, 'nothing': None}",
        });
        Assert.Equal("completed", SessionWait.Text(completed["status"]));
        Assert.Equal("caught\n", SessionWait.Text(completed["stdout"]));
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse("{\"false\":false,\"zero\":0,\"nothing\":null}"), completed["result"]));
        var failed = await f.Call("run_script", new JsonObject
        {
            ["code"] = caught + "raise ValueError('separate VM failure')",
        });
        Console.WriteLine(failed.ToJsonString());
        Assert.Equal("failed", SessionWait.Text(failed["status"]));
        Assert.Equal("ValueError: separate VM failure", SessionWait.Text(failed["error"]));
        Assert.Equal("caught\n", SessionWait.Text(failed["stdout"]));
        Assert.DoesNotContain("missing-native-file", SessionWait.Text(failed["error"]));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Native_pending_host_exception_survives_timeout_and_fresh_runtime_without_replay(bool caught)
    {
        await using var f = await ScriptFixture.Create();
        var calls = 0;
        var context = new ToolScriptContext(
            f.Owner,
            f.Owner.Id,
            async (_, _, _) =>
            {
                calls++;
                await Task.Delay(100);
                throw new FileNotFoundException("pending current host failure");
            },
            (_, _, _, _) => throw new InvalidOperationException("No model call."),
            (_, _, _) => throw new InvalidOperationException("No source read.")
        );
        var call = "value = " + MultilineCall;
        var code = caught
            ? "try:\n    " + call.Replace("\n", "\n    ")
                + "\nexcept RuntimeError as error:\n    print('caught')\n    return str(error)"
            : "print('before')\n" + call + "\nprint('after')\nreturn value";
        var paused = await f.Manager.ToolScript.ExecuteAsync("run_script", new JsonObject
        {
            ["code"] = code,
            ["timeoutSecs"] = .05,
        }, context, default);
        Assert.Equal("waiting", SessionWait.Text(paused["status"]));
        Assert.Equal("timeout", SessionWait.Text(paused["waitingReason"]));
        var id = SessionWait.Text(paused["runId"])!;
        var saved = (await f.Manager.ToolScript.Store.ReadAsync(id, default))!;
        Assert.Equal("exception", SessionWait.Text(saved["waiting"]?["timeout"]?["pendingResume"]?["mode"]));
        Assert.Equal("pending current host failure", SessionWait.Text(saved["waiting"]?["timeout"]?["pendingResume"]?["exception"]?["message"]));
        // Diagnostics are not the source of the exception delivered by continuation.
        saved["lastHostCall"]!["error"] = "unrelated stale host diagnostic";
        await f.Manager.ToolScript.Store.WriteAsync(saved, default);
        await f.Manager.ToolScript.DisposeAsync();
        await using var restarted = new MainToolScript(f.Data);
        var done = await restarted.ExecuteAsync("continue_script", new JsonObject
        {
            ["runId"] = id,
            ["continuationId"] = paused["continuationId"]!.DeepClone(),
            ["timeoutSecs"] = 30,
        }, context, default);
        Console.WriteLine(done.ToJsonString());
        Assert.Equal(caught ? "completed" : "failed", SessionWait.Text(done["status"]));
        Assert.Equal(1, calls);
        Assert.Equal(caught ? "pending current host failure" : "RuntimeError: pending current host failure",
            SessionWait.Text(done[caught ? "result" : "error"]));
        Assert.DoesNotContain("unrelated stale", done.ToJsonString());
        var final = (await restarted.Store.ReadAsync(id, default))!;
        Assert.Null(final["waiting"]);
        Assert.Null(final["snapshotBase64"]);
    }
}
