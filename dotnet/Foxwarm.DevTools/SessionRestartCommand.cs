using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.DevTools;

internal static class SessionRestartCommand
{
    public static async Task RunAsync(string[] args)
    {
        if (args.Length < 4)
            throw new ArgumentException("Usage: MODE ROOT SESSION_ID RESULT_PATH [BASE_URI EFFECT_ROOT]");

        var mode = args[0];
        var root = Path.GetFullPath(args[1]);
        var sessionId = args[2];
        var resultPath = Path.GetFullPath(args[3]);
        var startedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        Directory.CreateDirectory(Path.GetDirectoryName(resultPath)!);

        if (mode == "load-check")
        {
            var store = new PersistentSessionAuthorityStore(root, sessionId);
            try
            {
                _ = await store.LoadAsync(sessionId);
                throw new InvalidOperationException("load-check unexpectedly loaded active authority.");
            }
            catch (InvalidDataException error)
            {
                await WriteResultAsync(new JsonObject
                {
                    ["mode"] = mode,
                    ["pid"] = Environment.ProcessId,
                    ["startedAt"] = startedAt,
                    ["finishedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    ["errorType"] = error.GetType().Name
                });
                return;
            }
        }

        if (mode is "busy-b" or "busy-c")
        {
            if (mode == "busy-b" && args.Length != 6) throw new ArgumentException("Usage: busy-b ROOT SESSION_ID RESULT_PATH BASE_URI EFFECT_ROOT");
            if (mode == "busy-c" && args.Length != 4) throw new ArgumentException("Usage: busy-c ROOT SESSION_ID RESULT_PATH");
            var recoveryOptions = mode == "busy-b"
                ? new ResponsesClientOptions(new Uri(args[4], UriKind.Absolute), "test-model", "openai/test-model", "test-token", "instructions", 321)
                : new ResponsesClientOptions(new Uri("http://127.0.0.1:1"), "test-model", "openai/test-model", "test-token", "instructions", 321);
            await using var manager = new SessionManager(root, root + "-workspace", recoveryOptions, HostModels.ForTest(recoveryOptions));
            await manager.LoadMainHostAsync();
            var owner = await manager.RequiredAsync(sessionId);
            var deadline = DateTime.UtcNow.AddSeconds(15);
            SessionSnapshot snapshot;
            do
            {
                snapshot = owner.Entry.Snapshot();
                if (mode == "busy-c" || !snapshot.Busy && !snapshot.Stopping && snapshot.Queue.Count == 0) break;
                await Task.Delay(10);
            } while (DateTime.UtcNow < deadline);
            if (mode == "busy-b" && (snapshot.Busy || snapshot.Stopping || snapshot.Queue.Count != 0)) throw new TimeoutException("Recovered Session did not return idle.");
            await WriteResultAsync(new JsonObject
            {
                ["mode"] = mode,
                ["pid"] = Environment.ProcessId,
                ["startedAt"] = startedAt,
                ["finishedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["busy"] = snapshot.Busy,
                ["stopping"] = snapshot.Stopping,
                ["queueCount"] = snapshot.Queue.Count,
                ["queueSystems"] = new JsonArray(snapshot.Queue.SelectMany(item => item.Parts ?? []).Select(part => SessionWait.Text(part["system"])).Where(text => text is not null).Select(text => JsonValue.Create(text)).ToArray()),
                ["history"] = new JsonArray(snapshot.History.Select(row => JsonValue.Create(row.ToJsonString())).ToArray())
            });
            await manager.ShutdownAsync();
            return;
        }

        if (mode == "busy-a")
        {
            if (args.Length != 6) throw new ArgumentException("Usage: busy-a ROOT SESSION_ID RESULT_PATH BASE_URI EFFECT_ROOT");
            var busyBaseUri = new Uri(args[4], UriKind.Absolute);
            var busyOptions = new ResponsesClientOptions(busyBaseUri, "test-model", "openai/test-model", "test-token", "instructions", 321);
            var busyWorkspace = root + "-workspace"; Directory.CreateDirectory(busyWorkspace);
            await using var manager = new SessionManager(root, busyWorkspace, busyOptions, HostModels.ForTest(busyOptions));
            await manager.LoadMainHostAsync();
            var owner = await manager.CreateNamedAsync("main", sessionId, null, null);
            await owner.Registry.Ingress.EnqueueAsync(sessionId, QueueItem.UserText("busy restart"));
            _ = owner.Registry.TriggerProcessingAsync(sessionId);
            var busyAuthority = new PersistentSessionAuthorityStore(root, sessionId);
            var deadline = DateTime.UtcNow.AddSeconds(15);
            SessionSnapshot? busySnapshot = null;
            while (DateTime.UtcNow < deadline)
            {
                busySnapshot = await busyAuthority.LoadAsync(sessionId);
                if (busySnapshot?.Busy == true) break;
                await Task.Delay(10);
            }
            if (busySnapshot?.Busy != true) throw new TimeoutException("Owned producer did not persist busy state.");
            await WriteResultAsync(new JsonObject
            {
                ["mode"] = mode,
                ["pid"] = Environment.ProcessId,
                ["startedAt"] = startedAt,
                ["readyAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["busy"] = true,
                ["stopping"] = busySnapshot.Stopping
            });
            await Task.Delay(Timeout.InfiniteTimeSpan);
            return;
        }

        if (args.Length != 6) throw new ArgumentException("Turn modes require BASE_URI and EFFECT_ROOT.");
        var baseUri = new Uri(args[4], UriKind.Absolute);
        var effectRoot = Path.GetFullPath(args[5]);
        Directory.CreateDirectory(effectRoot);
        using var http = new HttpClient();
        var service = new ResponsesChatService(
            http,
            new ResponsesClientOptions(baseUri, "test-model", "openai/test-model", "test-token", "instructions", 321));
        var tools = new WriteFixtureToolExecutor(effectRoot);
        var authority = new PersistentSessionAuthorityStore(root, sessionId);
        var registry = new SessionRegistry(authority, service, tools);
        SessionEntry entry;
        var loadedHistoryCount = 0;
        var loadedNextMessageSeq = 1L;

        switch (mode)
        {
            case "a":
                entry = registry.Add(sessionId);
                entry.State.Queue.Add(QueueItem.UserText("write fixture in process A", clientMessageId: "process-a"));
                await registry.TriggerProcessingAsync(sessionId);
                RequireIdle(entry.Snapshot(), expectedHistoryCount: 4, expectedNextSeq: 5);
                if (tools.SuccessfulEffects != 1) throw new InvalidOperationException("Process A did not perform exactly one fixture effect.");
                break;
            case "b":
                entry = await registry.LoadOrAddAsync(sessionId);
                var loaded = entry.Snapshot();
                RequireIdle(loaded, expectedHistoryCount: 4, expectedNextSeq: 5);
                loadedHistoryCount = loaded.History.Count;
                loadedNextMessageSeq = loaded.NextMessageSeq;
                registry.TriggerOverride = _ => Task.CompletedTask;
                await registry.Ingress.EnqueueAsync(sessionId, QueueItem.UserText("continue in process B", clientMessageId: "process-b"));
                await registry.TriggerProcessingAsync(sessionId);
                RequireIdle(entry.Snapshot(), expectedHistoryCount: 6, expectedNextSeq: 7);
                if (tools.SuccessfulEffects != 0) throw new InvalidOperationException("Process B unexpectedly repeated a fixture effect.");
                break;
            default:
                throw new ArgumentException($"Unknown harness mode: {mode}");
        }

        var final = entry.Snapshot();
        await WriteResultAsync(new JsonObject
        {
            ["mode"] = mode,
            ["pid"] = Environment.ProcessId,
            ["startedAt"] = startedAt,
            ["finishedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            ["loadedHistoryCount"] = loadedHistoryCount,
            ["loadedNextMessageSeq"] = loadedNextMessageSeq,
            ["historyCount"] = final.History.Count,
            ["nextMessageSeq"] = final.NextMessageSeq,
            ["queueCount"] = final.Queue.Count,
            ["busy"] = final.Busy,
            ["stopping"] = final.Stopping,
            ["successfulEffects"] = tools.SuccessfulEffects,
            ["roles"] = new JsonArray(final.History.Select(message => JsonValue.Create(message["role"]!.GetValue<string>())).ToArray()),
            ["seqs"] = new JsonArray(final.History.Select(message => JsonValue.Create(message["__meta"]!["seq"]!.GetValue<long>())).ToArray())
        });
        return;

        async Task WriteResultAsync(JsonObject result) =>
            await File.WriteAllTextAsync(resultPath, result.ToJsonString());

        static void RequireIdle(SessionSnapshot snapshot, int expectedHistoryCount, long expectedNextSeq)
        {
            if (snapshot.Busy || snapshot.Stopping || snapshot.Queue.Count != 0)
                throw new InvalidOperationException("Harness Session is not clean idle.");
            if (snapshot.History.Count != expectedHistoryCount || snapshot.NextMessageSeq != expectedNextSeq)
                throw new InvalidOperationException("Harness Session history/sequence boundary is unexpected.");
        }
    }
}
