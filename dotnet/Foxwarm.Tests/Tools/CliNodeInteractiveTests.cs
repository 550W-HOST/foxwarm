using Foxwarm.CliNode;

namespace Foxwarm.Tests;

public sealed class CliNodeInteractiveTests
{
    private static NodeToolCall Call(string tool, string id = "one", double timeout = 0) =>
        new(tool, null, "main/one", id, timeout);

    private static ConsoleKeyInfo Key(char text) => new(text, ConsoleKey.NoName, false, false, false);

    [Theory]
    [InlineData("^(READ|write|apply_patch)$", "read", true)]
    [InlineData("^(READ|write|apply_patch)$", "exec", false)]
    [InlineData("^browse_.*$", "browse_screenshot", true)]
    [InlineData("^get_default_cwd$", "get_default_cwd", true)]
    [InlineData("\\bexec\\b", "exec", true)]
    [InlineData("^read\\.json$", "read", false)]
    [InlineData("", "write", false)]
    public async Task Native_pattern_matches_only_the_tool_name(string pattern, string tool, bool matches)
    {
        using var state = new InteractiveNode(new(Pattern: pattern));
        var decision = state.Intercept(Call(tool), CancellationToken.None);
        if (!matches)
        {
            Assert.False(decision.IsCompleted);
            state.Input([Key('n')]);
        }
        Assert.Equal(matches ? ToolApproval.Approved : ToolApproval.Rejected, await decision);
    }

    [Fact]
    public async Task Busy_slot_and_live_A_policy_preserve_the_original_request_and_exact_cancellation()
    {
        using var state = new InteractiveNode(new(Pattern: "^read$"));
        using var firstStop = new CancellationTokenSource();
        var first = state.Intercept(Call("write", "first"), firstStop.Token);
        Assert.Equal(ToolApproval.Busy, await state.Intercept(Call("exec", "busy"), default));
        Assert.Equal(ToolApproval.Approved, await state.Intercept(Call("read", "pattern"), default));
        state.Input([Key('A')]);
        Assert.False(first.IsCompleted);
        Assert.Equal(ToolApproval.Approved, await state.Intercept(Call("write", "future"), default));
        state.Input([Key('a')]);
        firstStop.Cancel();
        Assert.Equal(ToolApproval.Cancelled, await first);
        var second = state.Intercept(Call("write", "second"), default);
        firstStop.Cancel();
        Assert.False(second.IsCompleted);
        state.Input([Key('Y')]);
        Assert.Equal(ToolApproval.Approved, await second);
    }

    [Fact]
    public async Task Deadline_is_server_first_with_subtraction_minimum_and_no_deadline_shutdown()
    {
        using var state = new InteractiveNode(new(Timeout: 60));
        var start = System.Diagnostics.Stopwatch.StartNew();
        Assert.Equal(ToolApproval.Timeout, await state.Intercept(Call("write", timeout: 10), default));
        Assert.InRange(start.ElapsedMilliseconds, 900, 5000);
        using var untimed = new InteractiveNode(new());
        var waiting = untimed.Intercept(Call("write"), default);
        Assert.False(waiting.IsCompleted);
        untimed.Dispose();
        Assert.Equal(ToolApproval.Cancelled, await waiting);
        Assert.Throws<InvalidDataException>(() => new InteractiveNode(new(Pattern: "[")));
    }
}
