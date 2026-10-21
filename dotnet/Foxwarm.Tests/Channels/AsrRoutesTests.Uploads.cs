using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed partial class AsrRoutesTests
{
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

    [Theory]
    [InlineData("synthetic-alice", "", 1000000, 400)]
    [InlineData("synthetic-alice", "?sessionId=other", 1000000, 403)]
    [InlineData("synthetic-alice", "?sessionId=chat", 1073741825, 413)]
    [InlineData(Fixture.Token, "", 1073741825, 413)]
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
