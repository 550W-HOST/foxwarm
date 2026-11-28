using Microsoft.AspNetCore.Http;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed partial class AsrRoutesTests
{
    [Fact]
    public async Task SpeechAndAttachmentsShareMultipartSlots()
    {
        await using var f = await Fixture.Create(capabilities: RuntimeCapabilities.Hosted with { Egress = Foxwarm.Net.EgressPolicy.Unguarded });
        var both = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var started = 0;
        f.Upload = async context =>
        {
            if (Interlocked.Increment(ref started) == 2) both.TrySetResult();
            await release.Task.WaitAsync(context.RequestAborted);
            await context.Response.WriteAsJsonAsync(new { text = "done" });
        };
        using var audio1 = f.Audio(100000);
        using var audio2 = f.Audio(100000);
        var first = f.Client.PostAsync("api/asr/transcribe", audio1);
        var second = f.Client.PostAsync("api/asr/transcribe", audio2);
        try
        {
            await both.Task.WaitAsync(TimeSpan.FromSeconds(10));
            using var upload = new MultipartFormDataContent { { new ByteArrayContent([1]), "file", "sample.bin" } };
            using var denied = await f.Client.PostAsync("api/upload", upload);
            Assert.Equal(HttpStatusCode.TooManyRequests, denied.StatusCode);
            using var audio3 = f.Audio(44);
            // Refusal has to occur before forwarding to the peer.
            using var bound = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            using var busy = await f.Client.PostAsync("api/asr/transcribe", audio3, bound.Token);
            Assert.Equal(HttpStatusCode.TooManyRequests, busy.StatusCode);
            Assert.Equal(2, started);
        }
        finally { release.TrySetResult(); await Task.WhenAll(first, second); }
        using var next = new MultipartFormDataContent { { new ByteArrayContent([1]), "file", "sample.bin" } };
        using var accepted = await f.Client.PostAsync("api/upload", next);
        Assert.Equal(HttpStatusCode.OK, accepted.StatusCode);
    }

    [Fact]
    public async Task FailedStagingCreationDoesNotConsumePendingSpace()
    {
        if (!OperatingSystem.IsLinux()) return;
        await using var f = await Fixture.Create(capabilities: RuntimeCapabilities.Hosted with { Limits = Foxwarm.Limits.TenantLimits.Defaults with { UploadBytes = 8 } });
        async Task<HttpStatusCode> Send(string name)
        {
            using var contents = new MultipartFormDataContent { { new ByteArrayContent(new byte[8]), "file", name } };
            using var result = await f.Client.PostAsync("api/upload", contents);
            return result.StatusCode;
        }
        // The multipart filename is valid. Adding the random on-disk prefix puts this
        // component over NAME_MAX, so CreateNew and a subsequent File.Delete both fail.
        Assert.Equal(HttpStatusCode.BadRequest, await Send("a." + new string('x', 230)));
        Assert.Equal(HttpStatusCode.OK, await Send("first.bin"));
        Assert.Equal(HttpStatusCode.OK, await Send("second.bin"));
    }

    [Theory]
    [InlineData(8, 200)]
    [InlineData(9, 413)]
    public async Task Hosted_upload_limit_counts_file_bytes_without_multipart_headers(int bytes, int status)
    {
        await using var f = await Fixture.Create(capabilities: RuntimeCapabilities.Hosted with { Limits = Foxwarm.Limits.TenantLimits.Defaults with { UploadBytes = 8 } });
        using var form = new MultipartFormDataContent { { new ByteArrayContent(new byte[bytes]), "file", "sample.bin" } };
        using var response = await f.Client.PostAsync("/api/upload", form);
        var result = await Json(response);
        Assert.True((int)response.StatusCode == status, result.ToJsonString());
        if (status == 413)
            Assert.Equal("This file is larger than the 8 bytes upload limit.", result["error"]!.ToString());
        else
            Assert.Equal(bytes, new FileInfo(result["path"]!.ToString()).Length);
    }

    [Fact]
    public async Task Upload_stages_in_OS_temporary_directory_and_preparation_consumes_it()
    {
        await using var f = await Fixture.Create();
        using var form = new MultipartFormDataContent();
        form.Add(new ByteArrayContent([1, 2, 3]), "file", "owned.abcdefghijklmnopqrstuvwx");
        var response = await f.Client.PostAsync("/api/upload", form);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        var upload = await Json(response);
        var path = upload["path"]!.ToString();
        try
        {
            Assert.Equal(
                Path.Combine(Path.GetTempPath(), "foxwarm-uploads"),
                Path.GetDirectoryName(path)
            );
            Assert.Equal(".abcdefghijklmnopqrstuvwx", Path.GetExtension(path));
            Assert.False(Directory.Exists(Path.Combine(f.Data, "state", "webui-uploads")));
            var owner = await f.Manager.CreateNamedAsync("main", "upload", null, null);
            var files = new Foxwarm.Channels.WebUi.WebUiUploadedFiles(f.Manager);
            using var admission = f.Manager.BeginFileIngress(owner);
            var result = await files.PrepareAsync(
                new JsonObject { ["uploadedFiles"] = new JsonArray(upload.DeepClone()) },
                owner,
                default
            );
            Assert.Equal(
                new byte[] { 1, 2, 3 },
                await File.ReadAllBytesAsync(result.SavedFiles.Single()["path"]!.ToString())
            );
            Assert.False(File.Exists(path));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public async Task Upload_accepts_real_chunked_inclusive_GiB_file_and_rejects_the_next_byte()
    {
        await using var f = await Fixture.Create();
        f.Client.Timeout = TimeSpan.FromMinutes(3);
        foreach (
            var length in new[]
            {
                Foxwarm.Channels.WebUi.WebUiUploadedFiles.Limit,
                Foxwarm.Channels.WebUi.WebUiUploadedFiles.Limit + 1,
            }
        )
        {
            using var form = new MultipartFormDataContent();
            form.Add(new PatternContent(length), "file", "owned.bin");
            var response = await f.Client.PostAsync("/api/upload", form);
            if (length > Foxwarm.Channels.WebUi.WebUiUploadedFiles.Limit)
            {
                Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
                continue;
            }
            Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
            var path = (await Json(response))["path"]!.ToString();
            try
            {
                await using var input = File.OpenRead(path);
                Assert.Equal(length, input.Length);
                var buffer = new byte[65536];
                int read;
                long count = 0;
                while ((read = await input.ReadAsync(buffer)) > 0)
                {
                    Assert.True(buffer.AsSpan(0, read).IndexOfAnyExcept((byte)0x5a) < 0);
                    count += read;
                }
                Assert.Equal(length, count);
            }
            finally
            {
                File.Delete(path);
            }
        }
    }

    private sealed class PatternContent(long size) : HttpContent
    {
        protected override bool TryComputeLength(out long length)
        {
            length = 0;
            return false;
        }

        protected override async Task SerializeToStreamAsync(
            Stream stream,
            System.Net.TransportContext? context
        )
        {
            var buffer = new byte[65536];
            Array.Fill(buffer, (byte)0x5a);
            for (long written = 0; written < size; )
            {
                var count = (int)Math.Min(buffer.Length, size - written);
                await stream.WriteAsync(buffer.AsMemory(0, count));
                written += count;
            }
        }
    }

    [Fact]
    public async Task Real_scoped_upload_remains_identity_session_owned_and_revocation_removes_only_its_staging()
    {
        await using var f = await Fixture.Create(url =>
            $"asrService:\n  url: {url}\n  key: {Fixture.Key}\naccess:\n  identities:\n    alice:\n      token: synthetic-alice\n      surfaces:\n        webui:\n          sessions: [chat, other]\n    bob:\n      token: synthetic-bob\n      surfaces:\n        webui:\n          sessions: [chat]\n"
        );
        await Assert.ThrowsAsync<System.Net.WebSockets.WebSocketException>(() =>
            f.Connect(credential: "synthetic-alice")
        );
        Assert.Equal(0, f.Requests);
        var chat = await f.Manager.CreateNamedAsync("main", "chat", null, null);
        var other = await f.Manager.CreateNamedAsync("main", "other", null, null);
        f.Client.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-alice");
        using var form = new MultipartFormDataContent();
        form.Add(new ByteArrayContent([7, 1, 3]), "file", "scoped.bin");
        var response = await f.Client.PostAsync(
            "/api/upload?sessionId=" + Uri.EscapeDataString(chat.Id),
            form
        );
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        var upload = await Json(response);
        var path = upload["path"]!.ToString();
        try
        {
            var input = new JsonObject { ["uploadedFiles"] = new JsonArray(upload.DeepClone()) };
            f.Client.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-bob");
            Assert.Equal(
                HttpStatusCode.Forbidden,
                (
                    await f.Client.PostAsJsonAsync("/api/sessions/" + chat.Id + "/message", input)
                ).StatusCode
            );
            f.Client.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-alice");
            Assert.Equal(
                HttpStatusCode.Forbidden,
                (
                    await f.Client.PostAsJsonAsync("/api/sessions/" + other.Id + "/message", input)
                ).StatusCode
            );
            Assert.True(File.Exists(path));
            await f.Manager.Models.ConfigurationOwner!.Access.ApplyAsync(
                Foxwarm.AccessConfiguration.Normalize(null, false)
            );
            Assert.False(File.Exists(path));
            Assert.False(Directory.Exists(Path.Combine(f.Work, ".temp", "channel-files")));
        }
        finally
        {
            File.Delete(path);
        }
    }

    // A declared length past the 1 GiB file limit and its 1 MiB of multipart framing is refused
    // from the headers alone.
    [Theory]
    [InlineData("synthetic-alice", "", 1000000, 400)]
    [InlineData("synthetic-alice", "?sessionId=other", 1000000, 403)]
    [InlineData("synthetic-alice", "?sessionId=chat", 1074790401, 413)]
    [InlineData(Fixture.Token, "", 1074790401, 413)]
    public async Task Upload_rejects_headers_without_consuming_any_multipart_body_or_creating_files(
        string token,
        string query,
        long length,
        int status
    )
    {
        await using var f = await Fixture.Create(_ =>
            "access:\n  identities:\n    alice:\n      token: synthetic-alice\n      surfaces:\n        webui:\n          sessions: [chat]\n"
        );
        await f.Manager.CreateNamedAsync("main", "chat", null, null);
        await f.Manager.CreateNamedAsync("main", "other", null, null);
        var root = Foxwarm.Channels.WebUi.WebUiUploadedFiles.StagingRoot;
        var before = Directory.Exists(root) ? Directory.GetFiles(root).Order().ToArray() : [];
        using var socket = new System.Net.Sockets.TcpClient();
        await socket.ConnectAsync(f.Client.BaseAddress!.Host, f.Client.BaseAddress.Port);
        await socket
            .GetStream()
            .WriteAsync(
                System.Text.Encoding.ASCII.GetBytes(
                    $"POST /api/upload{query} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nContent-Type: multipart/form-data; boundary=owned\r\nContent-Length: {length}\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n"
                )
            );
        using var reader = new StreamReader(socket.GetStream());
        var first = await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5));
        Assert.StartsWith("HTTP/1.1 " + status + " ", first);
        Assert.Equal(
            before,
            Directory.Exists(root) ? Directory.GetFiles(root).Order().ToArray() : []
        );
        Assert.False(Directory.Exists(Path.Combine(f.Work, ".temp", "channel-files")));
    }

    [Fact]
    public async Task Real_inflight_scope_revocation_aborts_incomplete_multipart_without_publishing_staged_files()
    {
        await using var f = await Fixture.Create(_ =>
            "access:\n  identities:\n    alice:\n      token: synthetic-alice\n      surfaces:\n        webui:\n          sessions: [chat]\n"
        );
        await f.Manager.CreateNamedAsync("main", "chat", null, null);
        var root = Foxwarm.Channels.WebUi.WebUiUploadedFiles.StagingRoot;
        var before = Directory.Exists(root) ? Directory.GetFiles(root).Order().ToArray() : [];
        using var socket = new System.Net.Sockets.TcpClient();
        await socket.ConnectAsync(f.Client.BaseAddress!.Host, f.Client.BaseAddress.Port);
        var stream = socket.GetStream();
        await stream.WriteAsync(
            System.Text.Encoding.ASCII.GetBytes(
                "POST /api/upload?sessionId=chat HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer synthetic-alice\r\nContent-Type: multipart/form-data; boundary=owned\r\nContent-Length: 1000000\r\nExpect: 100-continue\r\n\r\n"
            )
        );
        using var reader = new StreamReader(stream);
        Assert.Equal(
            "HTTP/1.1 100 Continue",
            await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5))
        );
        Assert.Equal("", await reader.ReadLineAsync());
        await stream.WriteAsync(
            System.Text.Encoding.ASCII.GetBytes(
                "--owned\r\nContent-Disposition: form-data; name=\"file\"; filename=\"partial.bin\"\r\nContent-Type: application/octet-stream\r\n\r\npartial"
            )
        );
        await f.Manager.Models.ConfigurationOwner!.Access.ApplyAsync(
            Foxwarm.AccessConfiguration.Normalize(null, false)
        );
        try
        {
            Assert.Null(await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5)));
        }
        catch (IOException)
        { /* TCP reset is the other valid abort projection. */
        }
        Assert.Equal(
            before,
            Directory.Exists(root) ? Directory.GetFiles(root).Order().ToArray() : []
        );
        Assert.False(Directory.Exists(Path.Combine(f.Work, ".temp", "channel-files")));
    }
}
