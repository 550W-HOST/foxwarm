using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class SessionCommandEffectsTests
{
    private static Task<ExternalChannelFixture> FixtureAsync(Uri? provider = null) =>
        ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() },
            provider
        );

    private static async Task<JsonObject> SourceAsync(JsonObject input)
    {
        var root =
            Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")
            ?? throw new InvalidOperationException("FOXWARM_TS_ROOT is required");
        var start = new ProcessStartInfo(
            "node",
            Path.Combine(
                root,
                "dotnet",
                "Foxwarm.Tests",
                "Fixtures",
                "session-command-effects-fixture-ts.mjs"
            )
        )
        {
            WorkingDirectory = root,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        using var child = Process.Start(start)!;
        var output = child.StandardOutput.ReadToEndAsync();
        var errors = child.StandardError.ReadToEndAsync();
        await child.StandardInput.WriteAsync(input.ToJsonString());
        child.StandardInput.Close();
        await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20));
        Assert.True(child.ExitCode == 0, await errors);
        return JsonNode.Parse(await output)!.AsObject();
    }

    private static async Task<List<string>> CommandAsync(ExternalChannelFixture f, string text)
    {
        var replies = new List<string>();
        var context = new ExternalChannelContext(
            "alpha",
            "telegram",
            "commands",
            "11",
            "operator",
            value =>
            {
                replies.Add(value);
                return Task.CompletedTask;
            }
        );
        if (f.Manager.ChannelBinding(context.Target) is null)
            f.Manager.AttachChannel(context.Target, f.Owner);
        await f.Router.HandleExternalMessageAsync(
            context,
            new([new JsonObject { ["text"] = text }])
        );
        return replies;
    }

    private static Task AppendAsync(SessionOwner owner, params JsonObject[] rows) =>
        owner.Entry.SaveLane.CommitCanonicalAppendAsync(state =>
            LocalSessionTurnHost.PrepareCanonicalAppend(
                state,
                rows,
                [],
                false,
                false,
                () => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            )
        );

    private static JsonObject Text(string text) =>
        new() { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = text }) };

    private static JsonObject Call(string name, string id, JsonObject args) =>
        new()
        {
            ["role"] = "model",
            ["parts"] = new JsonArray(
                new JsonObject
                {
                    ["functionCall"] = new JsonObject
                    {
                        ["id"] = id,
                        ["name"] = name,
                        ["args"] = args.DeepClone(),
                    },
                }
            ),
        };

    private static JsonObject Response(string name, string id, string text) =>
        new()
        {
            ["role"] = "tool",
            ["parts"] = new JsonArray(
                new JsonObject
                {
                    ["functionResponse"] = new JsonObject
                    {
                        ["name"] = name,
                        ["tool_use_id"] = id,
                        ["response"] = new JsonObject { ["output"] = text },
                    },
                }
            ),
        };

    private static Task SendAsync(
        NetworkStream stream,
        string? text = "finished",
        JsonObject? call = null
    )
    {
        var output = new JsonArray();
        if (call is not null)
            output.Add(call.DeepClone());
        else if (text is not null)
            output.Add(
                new JsonObject
                {
                    ["type"] = "message",
                    ["role"] = "assistant",
                    ["content"] = new JsonArray(
                        new JsonObject { ["type"] = "output_text", ["text"] = text }
                    ),
                }
            );
        return LoopbackResponsesServer.WriteResponseAsync(
            stream,
            200,
            "text/event-stream",
            Encoding.UTF8.GetBytes(
                "data: "
                    + new JsonObject
                    {
                        ["type"] = "response.completed",
                        ["response"] = new JsonObject
                        {
                            ["id"] = Guid.NewGuid().ToString(),
                            ["output"] = output,
                        },
                    }.ToJsonString()
                    + "\n\n"
            )
        );
    }

    private static JsonObject ProviderCall(string name, JsonObject args) =>
        new()
        {
            ["type"] = "function_call",
            ["call_id"] = "usable-call",
            ["name"] = name,
            ["arguments"] = args.ToJsonString(),
        };

    private static TaskCompletionSource Signal() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private sealed class ConcurrentPeer : IAsyncDisposable
    {
        private readonly TcpListener listener = new(IPAddress.Loopback, 0);
        private readonly CancellationTokenSource stop = new();
        private readonly Task running;
        internal Uri Uri { get; }
        internal readonly ConcurrentQueue<JsonObject> Requests = new();

        internal ConcurrentPeer(int count, Func<int, NetworkStream, JsonObject, Task> handler)
        {
            listener.Start();
            Uri = new($"http://127.0.0.1:{((IPEndPoint)listener.LocalEndpoint).Port}/v1");
            running = RunAsync(count, handler);
        }

        private async Task RunAsync(int count, Func<int, NetworkStream, JsonObject, Task> handler)
        {
            var tasks = new List<Task>();
            for (var index = 0; index < count; index++)
            {
                var client = await listener.AcceptTcpClientAsync(stop.Token);
                var capturedIndex = index;
                tasks.Add(HandleAsync(client, capturedIndex, handler));
            }
            await Task.WhenAll(tasks);
        }

        private async Task HandleAsync(
            TcpClient client,
            int index,
            Func<int, NetworkStream, JsonObject, Task> handler
        )
        {
            using (client)
            {
                await using var stream = client.GetStream();
                var capture = await LoopbackResponsesServer.ReadRequestAsync(stream);
                var body = JsonNode.Parse(capture.Body)!.AsObject();
                Requests.Enqueue(body);
                await handler(index, stream, body);
            }
        }

        public async ValueTask DisposeAsync()
        {
            stop.Cancel();
            listener.Stop();
            try
            {
                await running.WaitAsync(TimeSpan.FromSeconds(5));
            }
            catch (OperationCanceledException) { }
            stop.Dispose();
        }
    }
}
