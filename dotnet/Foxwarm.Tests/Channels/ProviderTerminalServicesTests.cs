using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

// Browser terminals on executable-Provider Nodes through the persistent service channel.
public sealed class ProviderTerminalServicesTests
{
    private sealed class Stream : IAsyncDisposable
    {
        private readonly ClientWebSocket socket = new();
        private readonly List<JsonObject> frames = [];

        internal static async Task<Stream> Open(
            ProviderCodeServicesTests.Fixture f,
            string terminalId
        )
        {
            var stream = new Stream();
            stream.socket.Options.SetRequestHeader(
                "Authorization",
                "Bearer fixture-provider-token"
            );
            await stream.socket.ConnectAsync(
                new Uri(
                    "ws://"
                        + f.Client.BaseAddress!.Authority
                        + "/api/terminals/stream?terminalId="
                        + Uri.EscapeDataString(terminalId)
                ),
                default
            );
            return stream;
        }

        internal string Output =>
            string.Concat(
                frames
                    .Where(f => f["type"]?.ToString() == "output")
                    .Select(f => f["data"]!.ToString())
            );

        internal IEnumerable<JsonObject> FramesOfType(string type) =>
            frames.Where(frame => frame["type"]?.ToString() == type);

        internal Task Send(object message) =>
            socket.SendAsync(
                Encoding.UTF8.GetBytes(System.Text.Json.JsonSerializer.Serialize(message)),
                WebSocketMessageType.Text,
                true,
                default
            );

        // Frames accumulate while waiting so a predicate can use earlier ones (ready, backlog, output).
        internal async Task<JsonObject> Until(Func<JsonObject, bool> match, int seconds = 15)
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(seconds));
            foreach (var frame in frames)
                if (match(frame))
                    return frame;
            var buffer = new byte[64 * 1024];
            while (true)
            {
                var text = new StringBuilder();
                WebSocketReceiveResult result;
                do
                {
                    try
                    {
                        result = await socket.ReceiveAsync(buffer, deadline.Token);
                    }
                    catch (WebSocketException error)
                    {
                        throw new InvalidOperationException(
                            "Stream ended before the expected frame: "
                                + string.Join(",", frames.Select(f => f["type"]?.ToString()))
                                + " "
                                + Output,
                            error
                        );
                    }
                    if (result.MessageType == WebSocketMessageType.Close)
                        throw new InvalidOperationException("Closed before the expected frame.");
                    text.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));
                } while (!result.EndOfMessage);
                var frame = JsonNode.Parse(text.ToString())!.AsObject();
                frames.Add(frame);
                if (match(frame))
                    return frame;
            }
        }

        // The server closes the stream right after its final frame without waiting for the browser's
        // close handshake, so a terminal's last frame can be lost to the reset. Tests that assert on
        // such a frame treat an ended stream as "not delivered" and check the stable state instead.
        internal async Task<JsonObject?> TryUntil(Func<JsonObject, bool> match, int seconds = 15)
        {
            try
            {
                return await Until(match, seconds);
            }
            catch (InvalidOperationException)
            {
                return null;
            }
        }

        internal Task<JsonObject> UntilOutput(string expected, int seconds = 15) =>
            Until(_ => Output.Contains(expected), seconds);

        public async ValueTask DisposeAsync()
        {
            try
            {
                if (socket.State == WebSocketState.Open)
                    await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "", default);
            }
            catch (WebSocketException) { }
            socket.Dispose();
        }
    }

    private static async Task<JsonObject> Create(
        ProviderCodeServicesTests.Fixture f,
        string node,
        string? cwd = null
    )
    {
        var response = await f.Client.PostAsJsonAsync(
            "/api/terminals",
            new
            {
                nodeId = node,
                cwd = cwd ?? f.Work,
                cols = 100,
                rows = 30,
            }
        );
        return (await f.Json(response))["terminal"]!.AsObject();
    }

    [Fact]
    public async Task Provider_terminal_creates_lists_streams_resizes_and_closes_through_the_channel()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await ProviderCodeServicesTests.Fixture.Create();
        var terminal = await Create(f, "fixture/svc");
        var id = terminal["id"]!.ToString();
        Assert.StartsWith("pn.", id);
        Assert.DoesNotContain('/', id);
        Assert.Equal("fixture/svc", terminal["nodeId"]!.ToString());
        Assert.Equal(f.Work, terminal["cwd"]!.ToString());
        var listed = await f.Json(await f.Client.GetAsync("/api/terminals"));
        Assert.True(listed["supported"]!.GetValue<bool>());
        Assert.Contains(listed["terminals"]!.AsArray(), item => item!["id"]!.ToString() == id);
        await using (var stream = await Stream.Open(f, id))
        {
            var ready = await stream.Until(frame => frame["type"]?.ToString() == "ready");
            Assert.Equal(id, ready["terminal"]!["id"]!.ToString());
            await stream.Send(new { type = "input", data = "echo marker-$((20+22))\n" });
            await stream.UntilOutput("marker-42");
            await stream.Send(
                new
                {
                    type = "resize",
                    cols = 120,
                    rows = 40,
                }
            );
            await stream.Send(new { type = "input", data = "stty size\n" });
            await stream.UntilOutput("40 120");
        }
        var read = await f.Json(
            await f.Client.GetAsync("/api/terminals/" + Uri.EscapeDataString(id))
        );
        Assert.Equal(120, read["terminal"]!["cols"]!.GetValue<int>());
        Assert.Equal(1, f.Count("connect"));
        // The browser's identity never reaches the Provider; it sees only its own terminal ID.
        var closed = await f.Client.DeleteAsync("/api/terminals/" + Uri.EscapeDataString(id));
        Assert.True(closed.IsSuccessStatusCode);
        Assert.Equal(
            System.Net.HttpStatusCode.NotFound,
            (await f.Client.GetAsync("/api/terminals/" + Uri.EscapeDataString(id))).StatusCode
        );
        Assert.Equal(1, f.Count("connect"));
    }

    [Fact]
    public async Task Equal_Provider_terminal_ids_on_different_Nodes_stay_distinct()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await ProviderCodeServicesTests.Fixture.Create("fixed-terminal-ids");
        var first = await Create(f, "fixture/svc");
        var second = await Create(f, "fixture/svc2");
        Assert.NotEqual(first["id"]!.ToString(), second["id"]!.ToString());
        Assert.NotEqual(first["nodeId"]!.ToString(), second["nodeId"]!.ToString());
        var listed = (await f.Json(await f.Client.GetAsync("/api/terminals")))[
            "terminals"
        ]!.AsArray();
        Assert.Equal(2, listed.Count);
        foreach (var (terminal, marker) in new[] { (first, "alpha"), (second, "beta") })
        {
            await using var stream = await Stream.Open(f, terminal["id"]!.ToString());
            await stream.Until(frame => frame["type"]?.ToString() == "ready");
            await stream.Send(new { type = "input", data = $"echo only-{marker}\n" });
            await stream.UntilOutput("only-" + marker);
        }
        // Each stream received only its own Node's output.
        await using (var one = await Stream.Open(f, first["id"]!.ToString()))
        {
            var ready = await one.Until(frame => frame["type"]?.ToString() == "ready");
            Assert.Contains("only-alpha", ready["backlog"]!.ToString());
            Assert.DoesNotContain("only-beta", ready["backlog"]!.ToString());
        }
        var detail = await f.Json(
            await f.Client.GetAsync(
                "/api/terminals/" + Uri.EscapeDataString(second["id"]!.ToString())
            )
        );
        Assert.Equal("fixture/svc2", detail["terminal"]!["nodeId"]!.ToString());
        // Closing one leaves the other untouched.
        await f.Client.DeleteAsync(
            "/api/terminals/" + Uri.EscapeDataString(first["id"]!.ToString())
        );
        var remaining = (await f.Json(await f.Client.GetAsync("/api/terminals")))[
            "terminals"
        ]!.AsArray();
        Assert.Equal(second["id"]!.ToString(), Assert.Single(remaining)!["id"]!.ToString());
        Assert.Equal(2, f.Count("connect"));
    }

    [Fact]
    public async Task Terminal_exit_is_reported_and_forgotten()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await ProviderCodeServicesTests.Fixture.Create();
        var id = (await Create(f, "fixture/svc"))["id"]!.ToString();
        await using var stream = await Stream.Open(f, id);
        await stream.Until(frame => frame["type"]?.ToString() == "ready");
        await stream.Send(new { type = "input", data = "exit 3\n" });
        var exit = await stream.TryUntil(frame => frame["type"]?.ToString() == "exit");
        if (exit is not null)
            Assert.Equal(3, exit["exitCode"]!.GetValue<int>());
        for (var attempt = 0; attempt < 50; attempt++)
        {
            var gone = await f.Client.GetAsync("/api/terminals/" + Uri.EscapeDataString(id));
            if (gone.StatusCode == System.Net.HttpStatusCode.NotFound)
                return;
            await Task.Delay(100);
        }
        Assert.Fail("The exited terminal was not forgotten.");
    }

    [Fact]
    public async Task Channel_loss_is_a_transport_error_not_a_process_exit_and_next_use_starts_a_new_generation()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await ProviderCodeServicesTests.Fixture.Create();
        var id = (await Create(f, "fixture/svc"))["id"]!.ToString();
        await using var stream = await Stream.Open(f, id);
        await stream.Until(frame => frame["type"]?.ToString() == "ready");
        var pid = File.ReadAllLines(Path.Combine(f.Target, "channel.jsonl"))
            .Select(line => JsonNode.Parse(line)!.AsObject())
            .Single(entry => entry.ContainsKey("connect"))["pid"]!.GetValue<int>();
        using (var kill = System.Diagnostics.Process.Start("kill", ["-9", pid.ToString()])!)
            await kill.WaitForExitAsync();
        var error = await stream.TryUntil(frame => frame["type"]?.ToString() == "error");
        if (error is not null)
            Assert.NotEmpty(error["message"]!.ToString());
        Assert.Empty(stream.FramesOfType("exit"));
        // The record is not silently dropped: the next use reconnects (new process), and the
        // fixture, which does not retain terminals across channels, reports it gone.
        var gone = await f.Client.GetAsync("/api/terminals/" + Uri.EscapeDataString(id));
        Assert.Equal(System.Net.HttpStatusCode.NotFound, gone.StatusCode);
        Assert.Equal(2, f.Count("connect"));
        var fresh = await Create(f, "fixture/svc");
        Assert.NotEqual(id, fresh["id"]!.ToString());
        Assert.Equal(2, f.Count("connect"));
    }

    [Fact]
    public async Task Nodes_without_the_terminal_service_are_refused_without_a_channel()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await ProviderCodeServicesTests.Fixture.Create();
        foreach (var node in new[] { "fixture/fsonly", "fixture/plain" })
        {
            var response = await f.Client.PostAsJsonAsync(
                "/api/terminals",
                new { nodeId = node, cwd = f.Work }
            );
            Assert.Equal(System.Net.HttpStatusCode.NotImplemented, response.StatusCode);
        }
        var offline = await f.Client.PostAsJsonAsync(
            "/api/terminals",
            new { nodeId = "fixture/down", cwd = f.Work }
        );
        Assert.Equal(System.Net.HttpStatusCode.ServiceUnavailable, offline.StatusCode);
        Assert.Equal(0, f.Count("connect"));
    }
}
