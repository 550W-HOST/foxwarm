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
            Assert.Equal(Path.Combine(Path.GetTempPath(), "foxwarm-uploads"), Path.GetDirectoryName(path));
            Assert.Equal(".abcdefghijklmnopqrstuvwx", Path.GetExtension(path));
            Assert.False(Directory.Exists(Path.Combine(f.Data, "state", "webui-uploads")));
            var owner = await f.Manager.CreateNamedAsync("main", "upload", null, null);
            var files = new Foxwarm.Channels.WebUi.WebUiUploadedFiles(f.Manager);
            using var admission = f.Manager.BeginFileIngress(owner);
            var result = await files.PrepareAsync(new JsonObject { ["uploadedFiles"] = new JsonArray(upload.DeepClone()) }, owner, default);
            Assert.Equal(new byte[] {1,2,3}, await File.ReadAllBytesAsync(result.SavedFiles.Single()["path"]!.ToString()));
            Assert.False(File.Exists(path));
        }
        finally { File.Delete(path); }
    }

    [Fact]
    public async Task Upload_retains_Source_per_file_boundary_without_aggregate_body_ceiling()
    {
        await using var f = await Fixture.Create();
        const int size = 50 * 1024 * 1024;
        foreach (var length in new[] { size, size + 1 })
        {
            using var form = new MultipartFormDataContent();
            form.Add(new ByteArrayContent(new byte[length]), "file", "owned.bin");
            for (var i = 0; i < 3; i++)
                form.Add(new StringContent(new string('x', 900 * 1024)), "metadata" + i);
            var response = await f.Client.PostAsync("/api/upload", form);
            if (length > size)
            {
                Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
                continue;
            }
            Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
            var path = (await Json(response))["path"]!.ToString();
            try { Assert.Equal(length, new FileInfo(path).Length); }
            finally { File.Delete(path); }
        }
    }
    [Fact]
    public async Task Real_scoped_upload_remains_identity_session_owned_and_revocation_removes_only_its_staging()
    {
        await using var f = await Fixture.Create(url => $"asrService:\n  url: {url}\n  key: {Fixture.Key}\naccess:\n  identities:\n    alice:\n      token: synthetic-alice\n      surfaces:\n        webui:\n          sessions: [chat, other]\n    bob:\n      token: synthetic-bob\n      surfaces:\n        webui:\n          sessions: [chat]\n");
        await Assert.ThrowsAsync<System.Net.WebSockets.WebSocketException>(() => f.Connect(credential: "synthetic-alice"));
        Assert.Equal(0, f.Requests);
        var chat = await f.Manager.CreateNamedAsync("main", "chat", null, null);
        var other = await f.Manager.CreateNamedAsync("main", "other", null, null);
        f.Client.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-alice");
        using var form = new MultipartFormDataContent();
        form.Add(new ByteArrayContent([7, 1, 3]), "file", "scoped.bin");
        form.Add(new StringContent(chat.Id), "sessionId");
        var response = await f.Client.PostAsync("/api/upload", form);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        var upload = await Json(response);
        var path = upload["path"]!.ToString();
        try
        {
            var input = new JsonObject { ["uploadedFiles"] = new JsonArray(upload.DeepClone()) };
            f.Client.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-bob");
            Assert.Equal(HttpStatusCode.Forbidden, (await f.Client.PostAsJsonAsync("/api/sessions/" + chat.Id + "/message", input)).StatusCode);
            f.Client.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-alice");
            Assert.Equal(HttpStatusCode.Forbidden, (await f.Client.PostAsJsonAsync("/api/sessions/" + other.Id + "/message", input)).StatusCode);
            Assert.True(File.Exists(path));
            await f.Manager.Models.ConfigurationOwner!.Access.ApplyAsync(Foxwarm.AccessConfiguration.Normalize(null, false));
            Assert.False(File.Exists(path));
            Assert.False(Directory.Exists(Path.Combine(f.Work, ".temp", "channel-files")));
        }
        finally { File.Delete(path); }
    }
}
