using Foxwarm.Hosted;
using Foxwarm.Storage;
using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests.Hosted;

public sealed partial class TenantRuntimeConstructionTests
{
    [Fact]
    public async Task PendingUploadsAreBoundedSeparatelyForEachTenant()
    {
        await using var harness = await CreateAsync();
        await using var front = await TenantFront.StartAsync();
        var alphaLease = await harness.AddTenantAsync("alpha");
        var betaLease = await harness.AddTenantAsync("beta");
        await harness.Database.ExecuteOwnerAsync("UPDATE tenants SET limits='{\"uploadBytes\":8192}' WHERE name IN ('alpha','beta')");
        var interrupted = Path.Combine(harness.Scratch, "t", alphaLease.Id.ToString(), "foxwarm-uploads");
        Directory.CreateDirectory(interrupted);
        File.WriteAllText(Path.Combine(interrupted, "unfinished"), "partial");
        await using var alpha = await harness.BuildAsync("alpha", alphaLease, Deployment(null), server: front.Server("alpha.test"));
        await using var beta = await harness.BuildAsync("beta", betaLease, Deployment(null), server: front.Server("beta.test"));
        await alpha.StartAsync();
        await beta.StartAsync();
        Assert.False(Directory.Exists(interrupted));
        HttpClient Client(string slug, IHostedRuntime runtime) => front.Client(slug + ".test",
            ((MainHostRuntime)runtime).Host.Sessions.Storage.Credentials.Read(InstanceCredentialName.HttpToken));
        using var a = Client("alpha", alpha);
        using var b = Client("beta", beta);
        static async Task<HttpStatusCode> Upload(HttpClient client)
        {
            using var form = new MultipartFormDataContent { { new ByteArrayContent(new byte[8192]), "file", "sample.bin" } };
            using var result = await client.PostAsync("api/upload", form);
            return result.StatusCode;
        }
        Assert.Equal(HttpStatusCode.OK, await Upload(a));
        Assert.Equal(HttpStatusCode.OK, await Upload(a));
        Assert.Equal(HttpStatusCode.TooManyRequests, await Upload(a));
        Assert.Equal(HttpStatusCode.OK, await Upload(b));
        var sessions = ((MainHostRuntime)alpha).Host.Sessions;
        var staging = sessions.UploadStaging!;
        staging.Sweep(DateTimeOffset.UtcNow.AddDays(1));
        Assert.Empty(Directory.EnumerateFiles(staging.Root));
        Assert.Equal(HttpStatusCode.OK, await Upload(a));
        var path = Assert.Single(Directory.GetFiles(staging.Root));
        await alpha.DisposeAsync();
        Assert.False(File.Exists(path));
        await using var next = await harness.BuildAsync("alpha", alphaLease, Deployment(null), server: front.Server("alpha.test"));
        await next.StartAsync();
        using var nextClient = Client("alpha", next);
        var created = await nextClient.PostAsJsonAsync("api/sessions", new { agentId = "main", sessionId = "send" });
        created.EnsureSuccessStatusCode();
        using var send = await nextClient.PostAsJsonAsync("api/sessions/send/message", new { uploadedFiles = new[] { new { path } } });
        Assert.Equal(HttpStatusCode.BadRequest, send.StatusCode);
        Assert.Contains("Uploaded file is not a regular file in server upload staging", await send.Content.ReadAsStringAsync());
    }
}

public sealed class HostedUploadStagingTests
{
    [Fact]
    public void EmptyFilesOccupySpaceUntilReleased()
    {
        using var root = new TempDirectory();
        using var staging = new Foxwarm.Channels.WebUi.HostedUploadStaging(root.Path, 4096);
        Directory.CreateDirectory(staging.Root);
        string FileAt(int i) => Path.Combine(staging.Root, i.ToString());
        Assert.True(staging.Reserve(FileAt(1), 0));
        Assert.True(staging.Reserve(FileAt(2), 0));
        Assert.False(staging.Reserve(FileAt(3), 0));
        using (staging.PinRead(FileAt(2)))
        {
            staging.Delete(FileAt(2));
            Assert.False(staging.Reserve(FileAt(3), 0));
        }
        Assert.True(staging.Reserve(FileAt(3), 0));
    }

    private sealed class ResponseLifecycle : Microsoft.AspNetCore.Http.Features.HttpResponseFeature
    {
        private readonly Stack<Func<Task>> callbacks = [];
        public override void OnCompleted(Func<object, Task> callback, object state) => callbacks.Push(() => callback(state));
        internal async Task CompleteAsync()
        {
            while (callbacks.TryPop(out var callback)) await callback();
        }
    }

    [Fact]
    public async Task MultipartReservationsLastUntilTheFrameworkSpoolIsDisposed()
    {
        using var root = new TempDirectory();
        using var staging = new Foxwarm.Channels.WebUi.HostedUploadStaging(root.Path, 8192);
        var context = new DefaultHttpContext();
        var lifetime = new ResponseLifecycle();
        context.Features.Set<Microsoft.AspNetCore.Http.Features.IHttpResponseFeature>(lifetime);
        Assert.True(staging.ReserveMultipart(context.Response));
        Assert.True(staging.ReserveMultipart(new DefaultHttpContext().Response));
        Assert.False(staging.ReserveMultipart(new DefaultHttpContext().Response));
        // Like the form reader, register disposal after admission: space must still be
        // reserved while the framework is disposing its spool.
        context.Response.OnCompleted(() =>
        {
            Assert.False(staging.ReserveMultipart(new DefaultHttpContext().Response));
            return Task.CompletedTask;
        });
        await lifetime.CompleteAsync();
        Assert.True(staging.ReserveMultipart(new DefaultHttpContext().Response));
    }
}
