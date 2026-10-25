using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class InContextCompactTests
{
    private static JsonObject Text(string text, string role = "user") =>
        new() { ["role"] = role, ["parts"] = new JsonArray(new JsonObject { ["text"] = text }) };

    private static JsonObject Call(string id, string name, JsonObject args) =>
        new()
        {
            ["type"] = "function_call",
            ["call_id"] = id,
            ["name"] = name,
            ["arguments"] = args.ToJsonString(),
        };

    private static JsonObject Plan(long start = 2, long? end = null) =>
        new()
        {
            ["inContext"] = true,
            ["replaceAsBlocks"] = new JsonArray(new JsonObject
            {
                ["level"] = 1,
                ["sourceKind"] = "message",
                ["sourceStart"] = start,
                ["sourceEnd"] = end ?? start,
                ["summary"] = "Selected work is complete.",
            }),
        };

    private static JsonArray Final() =>
        new(new JsonObject
        {
            ["type"] = "message", ["role"] = "assistant",
            ["content"] = new JsonArray(new JsonObject { ["type"] = "output_text", ["text"] = "Done." }),
        });

    private sealed class Fixture : IAsyncDisposable
    {
        private readonly TempDirectory temp = new();
        internal readonly ScriptedResponsesSequenceServer Peer;
        internal readonly SessionManager Manager;
        internal SessionOwner Owner = null!;
        internal readonly List<JsonObject> Requests = [];
        internal int InputTokens = 50;
        internal Action<string, AtomicJsonWriteStage>? AuthorityHook;
        internal string Data => Path.Combine(temp.Path, "data");
        internal string Work => Path.Combine(temp.Path, "work");

        private Fixture(int requests, Func<Fixture, int, JsonObject, Task<JsonArray>> reply)
        {
            Directory.CreateDirectory(Work);
            Peer = new ScriptedResponsesSequenceServer(requests, async (index, stream, captured) =>
            {
                var request = JsonNode.Parse(captured.Body)!.AsObject();
                Requests.Add(request);
                var output = await reply(this, index, request);
                var payload = new JsonObject
                {
                    ["type"] = "response.completed",
                    ["response"] = new JsonObject
                    {
                        ["id"] = "in-context-" + index, ["output"] = output,
                        ["usage"] = new JsonObject { ["input_tokens"] = InputTokens, ["output_tokens"] = 10 },
                    },
                };
                await LoopbackResponsesServer.WriteResponseAsync(stream, 200, "text/event-stream",
                    Encoding.UTF8.GetBytes("data: " + payload.ToJsonString() + "\n\n"));
            });
            var options = new ResponsesClientOptions(Peer.BaseUri, "wire", "a/wire", "", "", 713);
            var models = HostModels.Parse(new JsonObject
            {
                ["default"] = "a",
                ["providers"] = new JsonObject
                {
                    ["a"] = new JsonObject
                    {
                        ["providerType"] = "openai-responses", ["baseUrl"] = Peer.BaseUri.ToString(),
                        ["models"] = new JsonArray("wire"), ["contextLimit"] = 20000, ["asyncCompact"] = false,
                    },
                },
            }, new JsonObject());
            Manager = new SessionManager(Path.Combine(temp.Path, "data"), Work, options, models,
                Path.Combine(temp.Path, "skills"), authorityStageHook: (id, stage) => AuthorityHook?.Invoke(id, stage));
        }

        internal static async Task<Fixture> CreateAsync(int requests,
            Func<Fixture, int, JsonObject, Task<JsonArray>> reply)
        {
            var fixture = new Fixture(requests, reply);
            await fixture.Manager.LoadMainHostAsync();
            fixture.Owner = await fixture.Manager.CreateNamedAsync("main", "inline", null, null);
            fixture.Owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            await fixture.AppendAsync(Text("Keep the beginning."));
            await fixture.AppendAsync(Text("Completed middle detail."));
            await fixture.AppendAsync(Text("Keep the later context."));
            return fixture;
        }

        internal async Task AppendAsync(JsonObject row)
        {
            await Owner.Registry.Ingress.EnqueueAsync(Owner.Id, QueueItem.Prebuilt(row));
            await Owner.Registry.HostFor(Owner.Id).AppendQueuedInputsAsync(Owner.Entry.State.Queue.ToArray());
        }

        internal async Task RunAsync()
        {
            await Owner.Registry.Ingress.EnqueueAsync(Owner.Id, QueueItem.UserText("Deliberate compact task."));
            await Owner.StartProcessing().WaitAsync(TimeSpan.FromSeconds(15));
        }

        internal JsonObject ToolResponse(string id) => Owner.History()
            .SelectMany(row => row["parts"]!.AsArray().OfType<JsonObject>())
            .Select(part => part["functionResponse"] as JsonObject)
            .OfType<JsonObject>().Single(response => SessionWait.Text(response["tool_use_id"]) == id);

        public async ValueTask DisposeAsync()
        {
            await Manager.DisposeAsync();
            await Peer.DisposeAsync();
            temp.Dispose();
        }
    }
}
