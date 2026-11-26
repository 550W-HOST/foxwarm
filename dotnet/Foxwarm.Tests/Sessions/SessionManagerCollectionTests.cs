using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

[Trait("Backend", "neutral")]
public sealed class SessionManagerCollectionTests
{
    // Process-wide objects created inside a manager's async flow (for example a
    // pooled SQLite connection's prune timer) capture that flow's AsyncLocal
    // scopes, which reference the manager. Creation and a real turn per owner
    // exercise the admission and turn scopes.
    [Fact]
    public async Task Disposed_manager_with_loaded_owners_and_committed_history_is_collected()
    {
        using var temp = new TempDirectory();
        await using var peer = await StreamingModelPeer.StartAsync(
            false,
            async (context, _) =>
            {
                var reply = new JsonObject
                {
                    ["type"] = "message",
                    ["role"] = "assistant",
                    ["status"] = "completed",
                    ["content"] = new JsonArray(
                        new JsonObject { ["type"] = "output_text", ["text"] = "Done." }
                    ),
                };
                await context.Send(ResponsesPrefixCommitTests.Done(0, reply));
                await context.Send(ResponsesPrefixCommitTests.Completed(reply));
            }
        );
        var manager = await UseAndDisposeAsync(temp.Path, peer.Uri);
        Assert.Equal(2, peer.Requests.Count);
        for (var attempt = 0; attempt < 20 && manager.IsAlive; attempt++)
        {
            GC.Collect();
            GC.WaitForPendingFinalizers();
            GC.Collect();
            if (manager.IsAlive)
                await Task.Delay(50);
        }
        Assert.False(manager.IsAlive);
    }

    // Kept out of line so no local of the test method roots the manager.
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static async Task<WeakReference> UseAndDisposeAsync(string root, Uri model)
    {
        var options = new ResponsesClientOptions(model, "offline", "fixture/offline", "", "", 713);
        var manager = new SessionManager(
            Path.Combine(root, "data"),
            Path.Combine(root, "work"),
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadMainHostAsync();
        foreach (var name in new[] { "first", "second" })
        {
            var owner = await manager.CreateNamedAsync("main", name, null, null);
            owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("Hello."));
            await owner.Registry.Runner.ProcessQueueAsync(owner.Id);
            Assert.Contains(owner.Entry.Snapshot().History, message => message.Role == "model");
        }
        Assert.Equal(2, manager.Owners().Count());
        await manager.DisposeAsync();
        return new WeakReference(manager);
    }
}
