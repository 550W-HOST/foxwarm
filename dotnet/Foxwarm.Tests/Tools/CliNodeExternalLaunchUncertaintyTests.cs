using System.Reflection;
using System.Text.Json.Nodes;
using Foxwarm.CliNode;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class CliNodeExternalLaunchUncertaintyTests
{
    private const BindingFlags PrivateInstance = BindingFlags.Instance | BindingFlags.NonPublic;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task External_release_retains_possible_live_launch_artifacts_but_cleans_definite_rejection(bool uncertain)
    {
        using var temp = new TempDirectory();
        var paths = new NodePaths(temp.Path);
        var client = new NodeClient(new NodeClientOptions("http://127.0.0.1:1", "owned", null, "synthetic-token",
            Path.Combine(temp.Path, "credentials.json"), LocalTrigger: false), paths);
        var owner = new JsonObject
        {
            ["kind"] = "external",
            ["externalId"] = "fixture",
            ["contextId"] = Guid.NewGuid().ToString(),
        };
        // Exercise the existing external lifecycle, injecting only at its established
        // native Launch seam. No real child or private BCL state is modified.
        var runtime = typeof(NodeClient).GetMethod("GetExternalRuntime", PrivateInstance)!.Invoke(client, [owner])!;
        var type = runtime.GetType();
        var root = (string)type.GetField("Root", PrivateInstance)!.GetValue(runtime)!;
        var managerField = type.GetField("Manager", PrivateInstance)!;
        await ((NodeExecManager)managerField.GetValue(runtime)!).DisposeAsync();
        var launches = 0;
        var manager = new NodeExecManager(paths, Path.Combine(root, "running.json"), (_, _, _) => Task.CompletedTask)
        {
            ExternalNamespace = true,
            Launch = start =>
            {
                launches++;
                var log = Path.Combine(start.Environment["FOXWARM_EXEC_LOG_DIR"]!, "owned.log");
                File.WriteAllText(log, "owned artifact");
                if (uncertain)
                    throw new ExecLaunchUncertainException(log);
                throw new IOException("definite fixture prelaunch rejection");
            },
        };
        managerField.SetValue(runtime, manager);
        var connectionType = typeof(NodeClient).GetNestedType("Connection", BindingFlags.NonPublic)!;
        using var connection = (IDisposable)Activator.CreateInstance(connectionType, nonPublic: true)!;
        connectionType.GetProperty("Protocol", PrivateInstance)!.SetValue(connection, 3);
        try
        {
            var frame = new JsonObject
            {
                ["owner"] = owner.DeepClone(),
                ["tool"] = "exec",
                ["backgroundExecId"] = "quiet-otter",
                ["completionCapability"] = "synthetic-grant",
                ["args"] = new JsonObject { ["command"] = "fixture-effect" },
            };
            var execution = (Task<JsonObject>)typeof(NodeClient).GetMethod("ExecuteExternal", PrivateInstance)!
                .Invoke(client, [connection, frame, (Action)(() => { })])!;
            await Assert.ThrowsAnyAsync<IOException>(() => execution);
            Assert.Equal(1, launches);
            Assert.True(Directory.Exists(root));
            typeof(NodeClient).GetMethod("ReleaseExternal", PrivateInstance)!.Invoke(client, [connection, owner]);
            var cleaning = type.GetField("Cleaning", PrivateInstance)!;
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            while ((bool)cleaning.GetValue(runtime)!)
                await Task.Delay(10, deadline.Token);
            Assert.Equal(uncertain, Directory.Exists(root));
            if (uncertain)
                Assert.Equal("owned artifact", await File.ReadAllTextAsync(Assert.Single(Directory.GetFiles(root, "*.log", SearchOption.AllDirectories))));
            Assert.Equal(1, launches);
        }
        finally
        {
            await (Task)typeof(NodeClient).GetMethod("DrainExec", PrivateInstance)!.Invoke(client, null)!;
        }
    }
}
