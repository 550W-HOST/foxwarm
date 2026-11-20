using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Foxwarm.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class NodeFileTransferTests
{
    [Fact]
    public async Task Target_receives_headers_after_Main_claims_the_request_before_source_data()
    {
        await using var f = new Fixture();
        await f.Start();
        var credentials = f.Manager.Nodes.Registry.Create("waiting-target");
        var socket = await f.Connect("waiting-target", credentials, streaming: true);
        var bytes = new byte[128 * 1024];
        await using var input = new InitiallyPausedStream(bytes);
        var writing = f.Manager.Nodes.WriteStreamAsync(
            "waiting-target",
            "target.bin",
            input,
            bytes.Length,
            false,
            f.Owner,
            false,
            default
        );
        var request = await Fixture.Read(socket);
        using var http = new HttpClient { BaseAddress = new Uri(f.App.Urls.Single()) };
        http.DefaultRequestHeaders.Add("X-Foxwarm-Node", "waiting-target");
        http.DefaultRequestHeaders.Authorization = new(
            "Bearer",
            credentials["authToken"]!.ToString()
        );
        using var response = await http.GetAsync(
                "/node/transfer/" + request["transferId"]!.ToString(),
                HttpCompletionOption.ResponseHeadersRead
            )
            .WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(bytes.Length, response.Content.Headers.ContentLength);
        input.Release.TrySetResult();
        var received = await response.Content.ReadAsByteArrayAsync();
        Assert.Equal(bytes, received);
        await Fixture.Send(socket, Fixture.Reply(request, received, write: true));
        await writing.WaitAsync(TimeSpan.FromSeconds(5));
    }

    private sealed class InitiallyPausedStream(byte[] bytes) : MemoryStream(bytes, writable: false)
    {
        internal readonly TaskCompletionSource Release = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );

        public override async ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken token = default
        )
        {
            await Release.Task.WaitAsync(token);
            return await base.ReadAsync(buffer, token);
        }
    }

    [Fact]
    public async Task Large_copy_streams_through_real_TypeScript_and_CSharp_CLI_nodes()
    {
        var repository =
            Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")
            ?? throw new InvalidOperationException("FOXWARM_TS_ROOT is required.");
        await using var f = new Fixture();
        await f.Start();
        var tsCredentials = f.Manager.Nodes.Registry.Create("ts-stream");
        var csCredentials = f.Manager.Nodes.Registry.Create("cs-stream");
        var tsRoot = Path.Combine(f.Temp.Path, "ts-cli");
        var csRoot = Path.Combine(f.Temp.Path, "cs-cli");
        Directory.CreateDirectory(tsRoot);
        Directory.CreateDirectory(csRoot);
        var ts = new ProcessStartInfo("node")
        {
            WorkingDirectory = tsRoot,
            UseShellExecute = false,
        };
        foreach (
            var arg in new[]
            {
                Path.Combine(repository, "packages/cli-node/dist/client.js"),
                "--host",
                f.App.Urls.Single(),
                "--id",
                "ts-stream",
                "--auth-token",
                tsCredentials["authToken"]!.ToString(),
                "--no-local-trigger",
                "--credentials-file",
                Path.Combine(tsRoot, "credentials.json"),
            }
        )
            ts.ArgumentList.Add(arg);
        ts.Environment["FOXWARM_AGENTS_DIR"] = Path.Combine(tsRoot, "agents");
        ts.Environment.Remove("FOXWARM_AGENT_DIR");
        ts.Environment["FOXWARM_NO_CONSOLE_LOG"] = "1";
        using var process = Process.Start(ts)!;
        var cs = new Foxwarm.CliNode.NodeClient(
            new Foxwarm.CliNode.NodeClientOptions(
                f.App.Urls.Single(),
                "cs-stream",
                null,
                csCredentials["authToken"]!.ToString(),
                null,
                LocalTrigger: false
            ),
            new Foxwarm.CliNode.NodePaths(csRoot)
        );
        using var stop = new CancellationTokenSource();
        var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        void Changed()
        {
            if (f.Manager.Nodes.Online("ts-stream") && f.Manager.Nodes.Online("cs-stream"))
                ready.TrySetResult();
        }
        f.Manager.Nodes.Changed += Changed;
        var running = cs.Run(stop.Token);
        try
        {
            Changed();
            await ready.Task.WaitAsync(TimeSpan.FromSeconds(15));
            const long length = 105L * 1024 * 1024 + 7;
            var source = Path.Combine(f.Work, "large.bin");
            await using (
                var file = new FileStream(
                    source,
                    FileMode.CreateNew,
                    FileAccess.Write,
                    FileShare.None
                )
            )
            {
                file.SetLength(length);
                file.Position = length - 1;
                await file.WriteAsync(new byte[] { 123 });
            }
            var baseline = GC.GetTotalMemory(false);
            long peak = baseline;
            using var sampling = new Timer(
                _ =>
                {
                    var current = GC.GetTotalMemory(false);
                    long previous;
                    do
                    {
                        previous = Interlocked.Read(ref peak);
                        if (current <= previous)
                            break;
                    } while (Interlocked.CompareExchange(ref peak, current, previous) != previous);
                },
                null,
                TimeSpan.Zero,
                TimeSpan.FromMilliseconds(10)
            );
            var args = new JsonObject
            {
                ["sourceNode"] = "master",
                ["sourcePath"] = "large.bin",
                ["targetNode"] = "ts-stream",
                ["targetPath"] = "first.bin",
            };
            var first = await f.Manager.CopyBetweenNodesAsync(f.Owner, args, default);
            args["sourceNode"] = "ts-stream";
            args["sourcePath"] = "first.bin";
            args["targetNode"] = "cs-stream";
            args["targetPath"] = Path.Combine(csRoot, "second.bin");
            var second = await f.Manager.CopyBetweenNodesAsync(f.Owner, args, default);
            args["sourceNode"] = "cs-stream";
            args["sourcePath"] = Path.Combine(csRoot, "second.bin");
            args["targetNode"] = "master";
            args["targetPath"] = "roundtrip.bin";
            var third = await f.Manager.CopyBetweenNodesAsync(f.Owner, args, default);
            Assert.Equal(length, third["sizeBytes"]!.GetValue<long>());
            Assert.Equal(first["sha256"]!.ToString(), second["sha256"]!.ToString());
            Assert.Equal(first["sha256"]!.ToString(), third["sha256"]!.ToString());
            await using var original = File.OpenRead(source);
            await using var result = File.OpenRead(Path.Combine(f.Work, "roundtrip.bin"));
            Assert.Equal(await SHA256.HashDataAsync(original), await SHA256.HashDataAsync(result));
            string? staged = null;
            f.Manager.AttachWebUi(f.Owner.Id, f.Owner);
            f.Manager.RegisterWebUiFileDelivery((_, path, _) => staged = path);
            var delivery = await f.Manager.SendFileAsync(
                f.Owner,
                new WorkspaceTools(f.Work),
                new JsonObject { ["node"] = "ts-stream", ["filePath"] = "first.bin" },
                default
            );
            Assert.NotNull(staged);
            Assert.Equal(length, new FileInfo(staged!).Length);
            await using var delivered = File.OpenRead(staged!);
            Assert.Equal(
                first["sha256"]!.ToString(),
                Convert.ToHexStringLower(await SHA256.HashDataAsync(delivered))
            );
            Assert.NotNull(delivery["fileDelivery"]);
            Assert.True(
                Interlocked.Read(ref peak) - baseline < 80L * 1024 * 1024,
                $"Managed memory grew by {(Interlocked.Read(ref peak) - baseline) / 1024 / 1024} MiB during a 105 MiB transfer."
            );
        }
        finally
        {
            stop.Cancel();
            await running.WaitAsync(TimeSpan.FromSeconds(10));
            f.Manager.Nodes.Changed -= Changed;
            if (!process.HasExited)
                process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync();
        }
    }

    [Fact]
    public async Task Small_files_use_JSON_and_the_64_KiB_write_boundary_starts_HTTP()
    {
        await using var f = new Fixture();
        await f.Start();
        var credentials = f.Manager.Nodes.Registry.Create("boundary-node");
        var socket = await f.Connect("boundary-node", credentials, streaming: true);
        var small = new byte[65535];
        RandomNumberGenerator.Fill(small);
        var opening = f.Manager.Nodes.OpenReadStreamAsync(
            "boundary-node",
            "small.bin",
            f.Owner,
            false,
            default
        );
        var request = await Fixture.Read(socket);
        Assert.Equal("file_stream_read_request", request["type"]!.ToString());
        await Fixture.Send(socket, Fixture.Reply(request, small));
        await using (var source = await opening)
        {
            using var target = new MemoryStream();
            await TransferStream.CopyAsync(source.Stream, target, source.Length, default);
            Assert.Equal(small, target.ToArray());
        }
        using var input = new MemoryStream(small, writable: false);
        var writing = f.Manager.Nodes.WriteStreamAsync(
            "boundary-node",
            "small.bin",
            input,
            small.Length,
            false,
            f.Owner,
            false,
            default
        );
        request = await Fixture.Read(socket);
        Assert.Equal("file_write_request", request["type"]!.ToString());
        await Fixture.Send(socket, Fixture.Reply(request, small, write: true));
        await writing;
        var boundary = new byte[65536];
        using var boundaryInput = new MemoryStream(boundary, writable: false);
        var pending = f.Manager.Nodes.WriteStreamAsync(
            "boundary-node",
            "boundary.bin",
            boundaryInput,
            boundary.Length,
            false,
            f.Owner,
            false,
            default
        );
        request = await Fixture.Read(socket);
        Assert.Equal("file_stream_write_request", request["type"]!.ToString());
        using var http = new HttpClient { BaseAddress = new Uri(f.App.Urls.Single()) };
        http.DefaultRequestHeaders.Add("X-Foxwarm-Node", "boundary-node");
        http.DefaultRequestHeaders.Authorization = new(
            "Bearer",
            credentials["authToken"]!.ToString()
        );
        using (
            var response = await http.GetAsync(
                "/node/transfer/" + request["transferId"]!.ToString()
            )
        )
            Assert.Equal(boundary, await response.Content.ReadAsByteArrayAsync());
        await Fixture.Send(socket, Fixture.Reply(request, boundary, write: true));
        await pending;
    }

    [Fact]
    public async Task Streaming_HTTP_requires_credential_direction_and_single_use_and_pipes_both_directions()
    {
        await using var f = new Fixture();
        await f.Start();
        var credentials = f.Manager.Nodes.Registry.Create("stream-node");
        var socket = await f.Connect("stream-node", credentials, streaming: true);
        using var http = new HttpClient { BaseAddress = new Uri(f.App.Urls.Single()) };
        http.DefaultRequestHeaders.Add("X-Foxwarm-Node", "stream-node");
        http.DefaultRequestHeaders.Authorization = new(
            "Bearer",
            credentials["authToken"]!.ToString()
        );
        var bytes = new byte[128 * 1024 + 9];
        RandomNumberGenerator.Fill(bytes);
        var opening = f.Manager.Nodes.OpenReadStreamAsync(
            "stream-node",
            "source.bin",
            f.Owner,
            false,
            default
        );
        var request = await Fixture.Read(socket);
        Assert.Equal("file_stream_read_request", request["type"]!.ToString());
        var id = request["transferId"]!.ToString();
        using (var wrong = await http.GetAsync("/node/transfer/" + id))
            Assert.Equal(HttpStatusCode.NotFound, wrong.StatusCode);
        using (var unauthenticated = new HttpClient { BaseAddress = http.BaseAddress })
        using (
            var response = await unauthenticated.PutAsync(
                "/node/transfer/" + id,
                new ByteArrayContent(bytes)
            )
        )
            Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        var otherCredentials = f.Manager.Nodes.Registry.Create("other-node");
        using (var other = new HttpClient { BaseAddress = http.BaseAddress })
        {
            other.DefaultRequestHeaders.Add("X-Foxwarm-Node", "other-node");
            other.DefaultRequestHeaders.Authorization = new(
                "Bearer",
                otherCredentials["authToken"]!.ToString()
            );
            using var response = await other.PutAsync(
                "/node/transfer/" + id,
                new ByteArrayContent(bytes)
            );
            Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        }
        using var content = new ByteArrayContent(bytes);
        var uploading = http.PutAsync("/node/transfer/" + id, content);
        await using var source = await opening.WaitAsync(TimeSpan.FromSeconds(5));
        using (
            var duplicate = await http.PutAsync("/node/transfer/" + id, new ByteArrayContent(bytes))
        )
            Assert.Equal(HttpStatusCode.Conflict, duplicate.StatusCode);
        using var received = new MemoryStream();
        var digest = await TransferStream.CopyAsync(
            source.Stream,
            received,
            source.Length,
            default
        );
        using (var response = await uploading.WaitAsync(TimeSpan.FromSeconds(5)))
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(bytes, received.ToArray());
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(bytes)), digest);

        using var input = new MemoryStream(bytes, writable: false);
        var writing = f.Manager.Nodes.WriteStreamAsync(
            "stream-node",
            "dest.bin",
            input,
            bytes.LongLength,
            false,
            f.Owner,
            false,
            default
        );
        request = await Fixture.Read(socket);
        Assert.Equal("file_stream_write_request", request["type"]!.ToString());
        id = request["transferId"]!.ToString();
        using (var response = await http.GetAsync("/node/transfer/" + id))
        {
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal(bytes.LongLength, response.Content.Headers.ContentLength);
            Assert.Equal(bytes, await response.Content.ReadAsByteArrayAsync());
        }
        await Fixture.Send(
            socket,
            new JsonObject
            {
                ["type"] = "file_write_response",
                ["transferId"] = id,
                ["result"] = new JsonObject
                {
                    ["filePath"] = "dest.bin",
                    ["sizeBytes"] = bytes.LongLength,
                    ["sha256"] = digest,
                },
            }
        );
        var result = await writing.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("dest.bin", result.Path);
        Assert.Equal(digest, result.Sha256);

        using var secondInput = new MemoryStream(bytes, writable: false);
        var uncertain = f.Manager.Nodes.WriteStreamAsync(
            "stream-node",
            "other.bin",
            secondInput,
            bytes.LongLength,
            false,
            f.Owner,
            false,
            default
        );
        request = await Fixture.Read(socket);
        id = request["transferId"]!.ToString();
        using (var response = await http.GetAsync("/node/transfer/" + id))
            _ = await response.Content.ReadAsByteArrayAsync();
        await Fixture.Send(
            socket,
            new JsonObject
            {
                ["type"] = "file_write_response",
                ["transferId"] = id,
                ["result"] = new JsonObject
                {
                    ["filePath"] = "other.bin",
                    ["sizeBytes"] = bytes.LongLength,
                    ["sha256"] = new string('0', 64),
                },
            }
        );
        var failure = await Assert.ThrowsAsync<IOException>(() => uncertain);
        Assert.Contains("may already have been published", failure.Message);
    }
}
