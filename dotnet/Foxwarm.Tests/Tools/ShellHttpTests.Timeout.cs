using System.Net;
using System.Reflection;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Nodes;

namespace Foxwarm.Tests;

public sealed partial class ShellHttpTests
{
    [Fact(Timeout = 75000)]
    public async Task Actual_62_second_unclaimed_deadline_removes_the_command_instead_of_requeuing_it()
    {
        await using var fixture = new Fixture();
        await fixture.Start();
        var fields = typeof(NodeConnectionHub).GetField("shellTasks", BindingFlags.NonPublic | BindingFlags.Instance)!;
        var tasks = (System.Collections.IDictionary)fields.GetValue(fixture.Manager.Nodes)!;
        var queued = fixture.Exec(new JsonObject { ["command"] = "printf must-not-start" });
        var oldTask = Assert.Single(tasks.Keys.Cast<string>());
        var error = await Assert.ThrowsAsync<IOException>(() => queued);
        Assert.Contains("not retried", error.Message);
        Assert.Empty(tasks.Keys);
        Assert.True(fixture.Manager.Nodes.Online("shell"));
        using var unknown = await fixture.Report(oldTask, true);
        Assert.Equal(HttpStatusCode.Gone, unknown.StatusCode);
        var successor = fixture.Exec(new JsonObject { ["command"] = "printf successor", ["timeout"] = 99 });
        var task = await fixture.Poll();
        Assert.NotEqual(oldTask, task.Task);
        Assert.DoesNotContain("must-not-start", task.Script);
        Assert.Equal("60", task.Timeout);
        using var response = await fixture.Report(task.Task, true, Encoding.UTF8.GetBytes("successor"));
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal(9, (await successor)!["totalBytes"]!.GetValue<long>());
    }
}
