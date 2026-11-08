using System.Net;
using System.Net.Http;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class NodeFileTransferTests
{
    private static async Task<(HttpClient Http, JsonObject Request)> StartBackgroundWrite(
        Fixture f,
        System.Net.WebSockets.ClientWebSocket socket,
        JsonObject credentials,
        string node
    )
    {
        var request = await Fixture.Read(socket);
        Assert.Equal("file_stream_write_request", request["type"]!.ToString());
        var http = new HttpClient { BaseAddress = new Uri(f.App.Urls.Single()) };
        http.DefaultRequestHeaders.Add("X-Foxwarm-Node", node);
        http.DefaultRequestHeaders.Authorization = new(
            "Bearer",
            credentials["authToken"]!.ToString()
        );
        using var response = await http.GetAsync(
            "/node/transfer/" + request["transferId"]!.ToString()
        );
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(128 * 1024, (await response.Content.ReadAsByteArrayAsync()).Length);
        return (http, request);
    }

    private static async Task<QueueItem> Completion(SessionOwner owner, string id)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (true)
        {
            var item = owner.Entry.WithState(state =>
                state.Queue.FirstOrDefault(value =>
                    SessionWait.Text(value.OpenFields?["execId"]) == id
                )
            );
            if (item is not null)
                return item;
            await Task.Delay(20, timeout.Token);
        }
    }

    private static JsonObject CopyArgs(string target, int timeout = 1) =>
        new()
        {
            ["sourceNode"] = "master",
            ["sourcePath"] = "source.bin",
            ["targetNode"] = target,
            ["targetPath"] = "destination.bin",
            ["timeout"] = timeout,
        };

    [Fact]
    public async Task Background_copy_waits_and_delivers_completion_after_Session_rename()
    {
        await using var f = new Fixture();
        await f.Start();
        var credentials = f.Manager.Nodes.Registry.Create("wait-node");
        var socket = await f.Connect("wait-node", credentials, streaming: true);
        var bytes = new byte[128 * 1024];
        await File.WriteAllBytesAsync(Path.Combine(f.Work, "source.bin"), bytes);
        var copying = f.Manager.CopyBetweenNodesAsync(f.Owner, CopyArgs("wait-node"), default);
        var (http, request) = await StartBackgroundWrite(f, socket, credentials, "wait-node");
        using (http)
        {
            var receipt = await copying.WaitAsync(TimeSpan.FromSeconds(5));
            var id = receipt["transferId"]!.ToString();
            Assert.StartsWith("transfer_", id);
            Assert.Equal(bytes.LongLength, receipt["sizeBytes"]!.GetValue<long>());
            var other = await f.Manager.CreateNamedAsync("main", "other", null, null);
            Assert.Throws<InvalidDataException>(() =>
                f.Manager.ValidateWait(
                    other,
                    new JsonObject { ["waitExecIds"] = new JsonArray(id) }
                )
            );
            await Assert.ThrowsAsync<InvalidDataException>(() =>
                f.Manager.CancelCopyTransferAsync(
                    other,
                    new JsonObject { ["transferId"] = id },
                    default
                )
            );
            await f
                .Manager.MoveIdentityAsync(f.Owner, new JsonObject { ["newSessionId"] = "renamed" })
                .WaitAsync(TimeSpan.FromSeconds(5));
            f.Owner.Entry.WithState(state => state.Busy = true);
            var waitArgs = new JsonObject
            {
                ["waitExecIds"] = new JsonArray(id),
                ["wakeIfNoActivityAfterSeconds"] = null,
            };
            await f.Manager.DeclareWaitAsync(f.Owner, waitArgs);
            await Fixture.Send(socket, Fixture.Reply(request, bytes, write: true));
            var completion = await Completion(f.Owner, id);
            var text = completion.Parts![0]["system"]!.ToString();
            Assert.Contains("background-transfer-finished", text);
            Assert.Contains("\"status\":\"completed\"", text);
            Assert.Single(
                f.Owner.Entry.WithState(state =>
                    state
                        .Queue.Where(item => SessionWait.Text(item.OpenFields?["execId"]) == id)
                        .ToArray()
                )
            );
            Assert.Null(f.Owner.WaitSnapshot());
            var completed = await f.Manager.CancelCopyTransferAsync(
                f.Owner,
                new JsonObject { ["transferId"] = id },
                default
            );
            Assert.Equal(bytes.LongLength, completed["sizeBytes"]!.GetValue<long>());
            f.Owner.Entry.WithState(state => state.Busy = false);
        }
    }

    [Fact]
    public async Task Stop_hands_off_the_copy_and_cancel_reports_uncertain_target_effect()
    {
        await using var f = new Fixture();
        await f.Start();
        var credentials = f.Manager.Nodes.Registry.Create("stop-node");
        var socket = await f.Connect("stop-node", credentials, streaming: true);
        var bytes = new byte[128 * 1024];
        await File.WriteAllBytesAsync(Path.Combine(f.Work, "source.bin"), bytes);
        using var foreground = new CancellationTokenSource();
        await using var mcp = new Foxwarm.McpClient(f.Data);
        var registry = SessionToolExecutor.CreateRegistry(
            FileDeliveryDefinitions.Definitions(),
            mcp,
            _ => f.Work,
            f.Manager.Nodes,
            f.Manager.NodeProviders
        );
        var tools = new SessionToolExecutor(
            new WorkspaceTools(f.Work),
            f.Owner,
            f.Manager,
            registry
        );
        tools.BeginTurn();
        var copying = tools.ExecuteAsync(
            new JsonObject
            {
                ["name"] = "copy_between_nodes",
                ["args"] = CopyArgs("stop-node", 90),
            },
            foreground.Token
        );
        var request = await Fixture.Read(socket);
        foreground.Cancel();
        var receipt = await copying.WaitAsync(TimeSpan.FromSeconds(5));
        var id = receipt!["transferId"]!.ToString();
        Assert.Contains("using 60s", receipt["output"]!.ToString());
        using var http = new HttpClient { BaseAddress = new Uri(f.App.Urls.Single()) };
        http.DefaultRequestHeaders.Add("X-Foxwarm-Node", "stop-node");
        http.DefaultRequestHeaders.Authorization = new(
            "Bearer",
            credentials["authToken"]!.ToString()
        );
        using (
            var response = await http.GetAsync(
                "/node/transfer/" + request["transferId"]!.ToString()
            )
        )
            Assert.Equal(bytes, await response.Content.ReadAsByteArrayAsync());
        f.Owner.Entry.WithState(state => state.Busy = true);
        var cancelled = await tools.ExecuteAsync(
            new JsonObject
            {
                ["name"] = "cancel_transfer",
                ["args"] = new JsonObject { ["transferId"] = id },
            },
            default
        );
        Assert.Contains(cancelled!["status"]!.ToString(), new[] { "cancelling", "cancelled" });
        var completion = await Completion(f.Owner, id);
        var text = completion.Parts![0]["system"]!.ToString();
        Assert.Contains("\"status\":\"cancelled\"", text);
        Assert.Contains("may already have been published", text);
        f.Owner.Entry.WithState(state => state.Busy = false);
    }

    [Fact]
    public async Task Transfer_deadlines_cover_request_start_receipt_and_no_progress()
    {
        await using var f = new Fixture();
        await f.Start();
        var sourceCredentials = f.Manager.Nodes.Registry.Create("deadline-source");
        var sourceSocket = await f.Connect("deadline-source", sourceCredentials, streaming: true);
        var receiptCredentials = f.Manager.Nodes.Registry.Create("deadline-receipt");
        var receiptSocket = await f.Connect(
            "deadline-receipt",
            receiptCredentials,
            streaming: true
        );
        var startCredentials = f.Manager.Nodes.Registry.Create("deadline-start");
        var startSocket = await f.Connect("deadline-start", startCredentials, streaming: true);
        await File.WriteAllBytesAsync(Path.Combine(f.Work, "source.bin"), new byte[128 * 1024]);
        f.Owner.Entry.WithState(state => state.Busy = true);
        var sourceCopy = f.Manager.CopyBetweenNodesAsync(
            f.Owner,
            new JsonObject
            {
                ["sourceNode"] = "deadline-source",
                ["sourcePath"] = "source.bin",
                ["targetNode"] = "master",
                ["targetPath"] = "stalled.bin",
                ["timeout"] = 1,
            },
            default
        );
        var receiptCopy = f.Manager.CopyBetweenNodesAsync(
            f.Owner,
            CopyArgs("deadline-receipt"),
            default
        );
        var startCopy = f.Manager.CopyBetweenNodesAsync(
            f.Owner,
            CopyArgs("deadline-start"),
            default
        );
        var sourceRequest = await Fixture.Read(sourceSocket);
        var receiptRequest = await Fixture.Read(receiptSocket);
        _ = await Fixture.Read(startSocket);
        using var sourceHttp = new HttpClient { BaseAddress = new Uri(f.App.Urls.Single()) };
        sourceHttp.DefaultRequestHeaders.Add("X-Foxwarm-Node", "deadline-source");
        sourceHttp.DefaultRequestHeaders.Authorization = new(
            "Bearer",
            sourceCredentials["authToken"]!.ToString()
        );
        using var content = new GatedContent();
        var upload = sourceHttp.PutAsync(
            "/node/transfer/" + sourceRequest["transferId"]!.ToString(),
            content
        );
        await content.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        using var targetHttp = new HttpClient { BaseAddress = new Uri(f.App.Urls.Single()) };
        targetHttp.DefaultRequestHeaders.Add("X-Foxwarm-Node", "deadline-receipt");
        targetHttp.DefaultRequestHeaders.Authorization = new(
            "Bearer",
            receiptCredentials["authToken"]!.ToString()
        );
        using (
            var response = await targetHttp.GetAsync(
                "/node/transfer/" + receiptRequest["transferId"]!.ToString()
            )
        )
            _ = await response.Content.ReadAsByteArrayAsync();
        var sourceId = (await sourceCopy)["transferId"]!.ToString();
        var receiptId = (await receiptCopy)["transferId"]!.ToString();
        var startId = (await startCopy)["transferId"]!.ToString();
        var clock = System.Diagnostics.Stopwatch.StartNew();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(70));
        async Task<QueueItem> Event(string id)
        {
            while (true)
            {
                var item = f.Owner.Entry.WithState(state =>
                    state.Queue.FirstOrDefault(value =>
                        SessionWait.Text(value.OpenFields?["execId"]) == id
                    )
                );
                if (item is not null)
                    return item;
                await Task.Delay(100, deadline.Token);
            }
        }
        try
        {
            var receiptEvent = await Event(receiptId);
            Assert.True(clock.Elapsed > TimeSpan.FromSeconds(25));
            Assert.Contains("\"status\":\"failed\"", receiptEvent.Parts![0]["system"]!.ToString());
            var startEvent = await Event(startId);
            Assert.Contains("\"status\":\"failed\"", startEvent.Parts![0]["system"]!.ToString());
            var sourceEvent = await Event(sourceId);
            Assert.True(clock.Elapsed > TimeSpan.FromSeconds(55));
            Assert.Contains("\"status\":\"failed\"", sourceEvent.Parts![0]["system"]!.ToString());
            Assert.False(File.Exists(Path.Combine(f.Work, "stalled.bin")));
        }
        finally
        {
            content.Release.TrySetResult();
            try
            {
                using var _ = await upload;
            }
            catch (Exception error)
                when (error is HttpRequestException or OperationCanceledException) { }
            f.Owner.Entry.WithState(state => state.Busy = false);
        }
    }

    [Fact]
    public async Task A_slow_upload_is_not_cut_off_by_the_servers_minimum_data_rate()
    {
        await using var f = new Fixture();
        await f.Start(strictDataRate: true);
        var credentials = f.Manager.Nodes.Registry.Create("slow-upload");
        var socket = await f.Connect("slow-upload", credentials, streaming: true);
        var copy = f.Manager.CopyBetweenNodesAsync(
            f.Owner,
            new JsonObject
            {
                ["sourceNode"] = "slow-upload",
                ["sourcePath"] = "source.bin",
                ["targetNode"] = "master",
                ["targetPath"] = "destination.bin",
                ["timeout"] = 10,
            },
            default
        );
        var request = await Fixture.Read(socket);
        using var http = new HttpClient { BaseAddress = new Uri(f.App.Urls.Single()) };
        http.DefaultRequestHeaders.Add("X-Foxwarm-Node", "slow-upload");
        http.DefaultRequestHeaders.Authorization = new(
            "Bearer",
            credentials["authToken"]!.ToString()
        );
        using var content = new GatedContent();
        var upload = http.PutAsync("/node/transfer/" + request["transferId"]!.ToString(), content);
        await content.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await Task.Delay(TimeSpan.FromSeconds(4));
        content.Release.TrySetResult();
        using var response = await upload.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await copy.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(128 * 1024, result["sizeBytes"]!.GetValue<long>());
    }

    [Fact]
    public async Task Cancel_before_the_body_finishes_removes_the_real_CLI_temporary_file()
    {
        await using var f = new Fixture();
        await f.Start();
        var sourceCredentials = f.Manager.Nodes.Registry.Create("slow-source");
        var sourceSocket = await f.Connect("slow-source", sourceCredentials, streaming: true);
        var targetCredentials = f.Manager.Nodes.Registry.Create("cancel-target");
        var root = Path.Combine(f.Temp.Path, "cancel-cli");
        Directory.CreateDirectory(root);
        var client = new Foxwarm.CliNode.NodeClient(
            new Foxwarm.CliNode.NodeClientOptions(
                f.App.Urls.Single(),
                "cancel-target",
                null,
                targetCredentials["authToken"]!.ToString(),
                null,
                LocalTrigger: false
            ),
            new Foxwarm.CliNode.NodePaths(root)
        );
        using var stop = new CancellationTokenSource();
        var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        void Changed()
        {
            if (f.Manager.Nodes.Online("cancel-target"))
                ready.TrySetResult();
        }
        f.Manager.Nodes.Changed += Changed;
        var running = client.Run(stop.Token);
        try
        {
            Changed();
            await ready.Task.WaitAsync(TimeSpan.FromSeconds(10));
            var copying = f.Manager.CopyBetweenNodesAsync(
                f.Owner,
                new JsonObject
                {
                    ["sourceNode"] = "slow-source",
                    ["sourcePath"] = "source.bin",
                    ["targetNode"] = "cancel-target",
                    ["targetPath"] = "destination.bin",
                    ["timeout"] = 1,
                },
                default
            );
            var request = await Fixture.Read(sourceSocket);
            using var http = new HttpClient { BaseAddress = new Uri(f.App.Urls.Single()) };
            http.DefaultRequestHeaders.Add("X-Foxwarm-Node", "slow-source");
            http.DefaultRequestHeaders.Authorization = new(
                "Bearer",
                sourceCredentials["authToken"]!.ToString()
            );
            using var content = new GatedContent();
            var upload = http.PutAsync(
                "/node/transfer/" + request["transferId"]!.ToString(),
                content
            );
            await content.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
            var receipt = await copying.WaitAsync(TimeSpan.FromSeconds(5));
            var id = receipt["transferId"]!.ToString();
            var directory = Path.Combine(root, "agents", "main");
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            while (
                !Directory.Exists(directory) || Directory.GetFiles(directory, "*.tmp").Length == 0
            )
                await Task.Delay(20, deadline.Token);
            await File.WriteAllTextAsync(Path.Combine(directory, "control.txt"), "control-ok");
            var control = await f
                .Manager.NodeProviders.ExecuteAsync(
                    "cancel-target",
                    "read",
                    new JsonObject { ["filePath"] = "control.txt" },
                    f.Owner.Id,
                    f.Owner.Agent,
                    "cancel-target",
                    null,
                    false,
                    default,
                    f.Owner
                )
                .WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Contains("control-ok", control!.ToJsonString());
            f.Owner.Entry.WithState(state => state.Busy = true);
            await f.Manager.CancelCopyTransferAsync(
                f.Owner,
                new JsonObject { ["transferId"] = id },
                default
            );
            await Completion(f.Owner, id);
            content.Release.TrySetResult();
            try
            {
                using var _ = await upload;
            }
            catch (HttpRequestException) { }
            while (Directory.GetFiles(directory, "*.tmp").Length > 0)
                await Task.Delay(20, deadline.Token);
            Assert.False(File.Exists(Path.Combine(directory, "destination.bin")));
            f.Owner.Entry.WithState(state => state.Busy = false);
        }
        finally
        {
            stop.Cancel();
            await running.WaitAsync(TimeSpan.FromSeconds(10));
            f.Manager.Nodes.Changed -= Changed;
        }
    }

    private sealed class GatedContent : HttpContent
    {
        internal readonly TaskCompletionSource Started = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        internal readonly TaskCompletionSource Release = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );

        protected override bool TryComputeLength(out long length)
        {
            length = 128 * 1024;
            return true;
        }

        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) =>
            SerializeToStreamAsync(stream, context, default);

        protected override async Task SerializeToStreamAsync(
            Stream stream,
            TransportContext? context,
            CancellationToken token
        )
        {
            await stream.WriteAsync(new byte[64 * 1024], token);
            await stream.FlushAsync(token);
            Started.TrySetResult();
            await Release.Task.WaitAsync(token);
            await stream.WriteAsync(new byte[64 * 1024], token);
        }
    }

    [Fact]
    public async Task Restart_clears_a_wait_on_a_lost_background_copy_without_a_completion_event()
    {
        await using var f = new Fixture();
        await f.Start();
        var credentials = f.Manager.Nodes.Registry.Create("restart-node");
        var socket = await f.Connect("restart-node", credentials, streaming: true);
        await File.WriteAllBytesAsync(Path.Combine(f.Work, "source.bin"), new byte[128 * 1024]);
        var copying = f.Manager.CopyBetweenNodesAsync(f.Owner, CopyArgs("restart-node"), default);
        var (http, _) = await StartBackgroundWrite(f, socket, credentials, "restart-node");
        using (http)
        {
            var receipt = await copying.WaitAsync(TimeSpan.FromSeconds(5));
            var id = receipt["transferId"]!.ToString();
            var ownerId = f.Owner.Id;
            await f.Manager.DeclareWaitAsync(
                f.Owner,
                new JsonObject
                {
                    ["waitExecIds"] = new JsonArray(id),
                    ["wakeIfNoActivityAfterSeconds"] = null,
                }
            );
            await f.Manager.ShutdownAsync().WaitAsync(TimeSpan.FromSeconds(10));
            await f.App.StopAsync();
            await f.Manager.DisposeAsync();
            var options = new ResponsesClientOptions(
                new Uri("http://127.0.0.1:1"),
                "wire",
                "a",
                "",
                "",
                713
            );
            f.Manager = new(f.Data, f.Work, options, HostModels.ForTest(options));
            await f.Manager.LoadAsync();
            f.Owner = (await f.Manager.GetExistingAsync(ownerId))!;
            Assert.Null(f.Owner.WaitSnapshot());
            Assert.DoesNotContain(
                f.Owner.Entry.WithState(state => state.Queue.ToArray()),
                item => SessionWait.Text(item.OpenFields?["execId"]) == id
            );
        }
    }

    [Fact]
    public async Task Session_deletion_cancels_the_background_transfer_without_waiting_for_receipt()
    {
        await using var f = new Fixture();
        await f.Start();
        var credentials = f.Manager.Nodes.Registry.Create("delete-node");
        var socket = await f.Connect("delete-node", credentials, streaming: true);
        await File.WriteAllBytesAsync(Path.Combine(f.Work, "source.bin"), new byte[128 * 1024]);
        var copying = f.Manager.CopyBetweenNodesAsync(f.Owner, CopyArgs("delete-node"), default);
        var (http, _) = await StartBackgroundWrite(f, socket, credentials, "delete-node");
        using (http)
        {
            _ = await copying.WaitAsync(TimeSpan.FromSeconds(5));
            var result = await f.Manager.DeleteAsync(f.Owner.Id).WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal("deleted", result["status"]!.ToString());
        }
    }
}
