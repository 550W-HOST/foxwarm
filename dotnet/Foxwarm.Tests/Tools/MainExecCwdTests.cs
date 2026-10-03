using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class MainExecCwdTests
{
    private static ResponsesClientOptions Options => new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);
    private static JsonObject Call(string command, int timeout = 15) => new() { ["id"] = Guid.NewGuid().ToString("N"), ["name"] = "exec", ["args"] = new JsonObject { ["command"] = command, ["timeout"] = (double)timeout } };
    private static (SessionToolExecutor Tools, Foxwarm.McpClient Mcp) Tools(SessionManager manager, SessionOwner owner, string data, string work)
    {
        var mcp = new Foxwarm.McpClient(data); var definitions = LocalExecManager.Definitions();
        var registry = SessionToolExecutor.CreateRegistry(definitions, mcp, _ => work);
        var tools = new SessionToolExecutor(new WorkspaceTools(work), owner, manager, registry); tools.BeginTurn(); return (tools, mcp);
    }
    [Fact]
    public async Task Finished_sidecar_is_real_child_cwd_and_reserved_agent_environment_is_independent_of_the_exec_default()
    {
        using var temp = new TempDirectory(); var data = Path.Combine(temp.Path, "data"); var work = Path.Combine(temp.Path, "work"); var cwd = Path.Combine(temp.Path, "cwd"); Directory.CreateDirectory(cwd);
        await using var manager = new SessionManager(data, work, Options, HostModels.ForTest(Options)); await manager.LoadAsync(); var owner = await manager.CreateNamedAsync("main", "exec", null, null); await owner.UpdateCwdAsync(cwd);
        var before = owner.Entry.Snapshot(); var (tools, mcp) = Tools(manager, owner, data, work); await using var dispose = mcp;
        var result = await tools.ExecuteAttributedAsync(Call("printf '%s\\n' \"$HOME\" \"$fw_agentdir\" \"$fw_tmp\"; cd \"$fw_tmp\"; pwd"), default);
        Assert.True(result.Response["error"] is null, result.Response.ToJsonString()); var output = result.Response["output"]!.GetValue<string>(); Assert.Contains(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), output);
        Assert.Contains(work + "\n" + Path.Combine(work, "tmp"), output); Assert.Contains("SESSION CWD CHANGED", output); Assert.Equal(Path.Combine(work, "tmp"), owner.Entry.Snapshot().AuthorityEnvelope["cwd"]!.GetValue<string>());
        var directories = Directory.GetDirectories(Path.Combine(data, "state", "exec", SessionIdentity.ExecDirectorySegment("exec")));
        Assert.Single(directories); Assert.Equal(Path.Combine(work, "tmp"), (await File.ReadAllTextAsync(Path.Combine(directories[0], "cwd.txt"))).Trim());
        Assert.True(JsonNode.DeepEquals(before.AuthorityEnvelope["promptCacheKey"], owner.Entry.Snapshot().AuthorityEnvelope["promptCacheKey"])); Assert.True(JsonNode.DeepEquals(before.AuthorityEnvelope["persistentMemorySnapshot"], owner.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]));
    }
    [Fact]
    public async Task Direct_segment_replays_actual_final_cwds_in_model_order_after_all_siblings_settle()
    {
        using var temp = new TempDirectory(); var data = Path.Combine(temp.Path, "data"); var work = Path.Combine(temp.Path, "work"); Directory.CreateDirectory(Path.Combine(work, "one")); Directory.CreateDirectory(Path.Combine(work, "two"));
        await using var manager = new SessionManager(data, work, Options, HostModels.ForTest(Options)); await manager.LoadAsync(); var owner = await manager.CreateNamedAsync("main", "exec", null, null);
        var (tools, mcp) = Tools(manager, owner, data, work); await using var dispose = mcp;
        using (tools.CaptureDirectExecSegment())
        {
            var first = tools.ExecuteAttributedAsync(Call("cd one; sleep 0.15; pwd"), default); var second = tools.ExecuteAttributedAsync(Call("cd two; pwd"), default);
            var results = await Task.WhenAll(first, second); Assert.Null(owner.Entry.Snapshot().AuthorityEnvelope["cwd"]);
            Assert.Equal(Path.Combine(work, "one"), results[0].DeferredCwd); Assert.Equal(Path.Combine(work, "two"), results[1].DeferredCwd);
            await tools.ReplayCwdAsync(results[0]); await tools.ReplayCwdAsync(results[1]); Assert.Equal(Path.Combine(work, "two"), owner.Entry.Snapshot().AuthorityEnvelope["cwd"]!.GetValue<string>());
        }
    }
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Raw_snapshot_keeps_a_captured_string_but_unset_snapshot_uses_invocation_time_live_cwd(bool declared)
    {
        using var temp = new TempDirectory(); var data = Path.Combine(temp.Path, "data"); var work = Path.Combine(temp.Path, "work"); var changed = Path.Combine(temp.Path, "changed"); Directory.CreateDirectory(changed);
        await using var manager = new SessionManager(data, work, Options, HostModels.ForTest(Options)); await manager.LoadAsync(); var owner = await manager.CreateNamedAsync("main", "exec", null, null);
        if (declared) await owner.UpdateCwdAsync(work);
        var (tools, mcp) = Tools(manager, owner, data, work); await using var dispose = mcp;
        using (tools.CaptureDirectExecSegment())
        {
            await owner.UpdateCwdAsync(changed); var execution = await tools.ExecuteAttributedAsync(Call("pwd"), default);
            Assert.True(execution.Response["error"] is null, execution.Response.ToJsonString()); Assert.Equal(declared ? work : changed, execution.DeferredCwd); Assert.Contains((declared ? work : changed) + "\n", execution.Response["output"]!.GetValue<string>());
            Assert.Equal(changed, owner.Entry.Snapshot().AuthorityEnvelope["cwd"]!.GetValue<string>());
        }
    }
    [Fact]
    public async Task Timeout_live_observation_updates_once_and_background_completion_does_not_overwrite_a_later_setter()
    {
        using var temp = new TempDirectory(); var data = Path.Combine(temp.Path, "data"); var work = Path.Combine(temp.Path, "work"); var first = Path.Combine(temp.Path, "first"); var later = Path.Combine(temp.Path, "later"); Directory.CreateDirectory(first); Directory.CreateDirectory(later);
        await using var manager = new SessionManager(data, work, Options, HostModels.ForTest(Options)); await manager.LoadAsync(); var owner = await manager.CreateNamedAsync("main", "exec", null, null);
        var (tools, mcp) = Tools(manager, owner, data, work); await using var dispose = mcp;
        var result = await tools.ExecuteAttributedAsync(Call($"cd '{first}'; sleep 1.8; cd '{later}'; pwd", 1), default); Assert.True(result.Response["error"] is null, result.Response.ToJsonString());
        Assert.Equal(first, owner.Entry.Snapshot().AuthorityEnvelope["cwd"]!.GetValue<string>()); await owner.UpdateCwdAsync(work);
        var directory = Directory.GetDirectories(Path.Combine(data, "state", "exec", SessionIdentity.ExecDirectorySegment("exec"))).Single();
        for (var i = 0; i < 150 && !File.Exists(Path.Combine(directory, "status.json")); i++) await Task.Delay(25);
        Assert.True(File.Exists(Path.Combine(directory, "status.json"))); Assert.Equal(later, (await File.ReadAllTextAsync(Path.Combine(directory, "cwd.txt"))).Trim());
        await Task.Delay(100); Assert.Equal(work, owner.Entry.Snapshot().AuthorityEnvelope["cwd"]!.GetValue<string>());
    }
    [Fact]
    public async Task Denial_and_cancellation_do_not_create_tmp_but_allowed_invalid_cwd_ensures_agent_tmp_only()
    {
        using var temp = new TempDirectory(); var data = Path.Combine(temp.Path, "data"); var work = Path.Combine(temp.Path, "work"); var missing = Path.Combine(temp.Path, "missing");
        await using var manager = new SessionManager(data, work, Options, HostModels.ForTest(Options)); await manager.LoadAsync(); var owner = await manager.CreateNamedAsync("main", "exec", null, null); await owner.UpdateCwdAsync(missing);
        var (tools, mcp) = Tools(manager, owner, data, work); await using var dispose = mcp;
        await manager.Authorization.InstallAsync(System.Text.Encoding.UTF8.GetBytes("version: 1\ndefaultAction: deny"), default);
        var denied = await tools.ExecuteAttributedAsync(Call("pwd"), default); Assert.NotNull(denied.Response["error"]); Assert.False(Directory.Exists(Path.Combine(work, "tmp")));
        using var cancelled = new CancellationTokenSource(); cancelled.Cancel(); await Assert.ThrowsAnyAsync<OperationCanceledException>(() => tools.ExecuteAttributedAsync(Call("pwd"), cancelled.Token)); Assert.False(Directory.Exists(Path.Combine(work, "tmp")));
        await manager.Authorization.InstallAsync(System.Text.Encoding.UTF8.GetBytes("version: 1"), default);
        var invalid = await tools.ExecuteAttributedAsync(Call("pwd"), default); Assert.NotNull(invalid.Response["error"]); Assert.True(Directory.Exists(Path.Combine(work, "tmp"))); Assert.False(Directory.Exists(missing));
    }
}
