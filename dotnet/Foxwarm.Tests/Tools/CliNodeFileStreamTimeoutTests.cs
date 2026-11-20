using System.Diagnostics;
using Foxwarm.CliNode;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Foxwarm.Tests;

public sealed class CliNodeFileStreamTimeoutTests
{
    [Theory]
    [InlineData(404)]
    [InlineData(405)]
    [InlineData(413)]
    [InlineData(502)]
    public async Task Both_transfer_directions_report_the_HTTP_status(int status)
    {
        using var temp = new TempDirectory();
        var source = Path.Combine(temp.Path, "source");
        await File.WriteAllBytesAsync(source, new byte[128 * 1024]);
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        await using var app = builder.Build();
        app.Map(
            "/node/transfer/{id}",
            context =>
            {
                context.Response.StatusCode = status;
                return Task.CompletedTask;
            }
        );
        await app.StartAsync();
        var client = new NodeFileStream(
            new NodePaths(temp.Path),
            app.Urls.Single(),
            "node",
            "token"
        );
        try
        {
            var read = await Assert.ThrowsAsync<HttpRequestException>(() =>
                client.Read("read", source, "main", false, default)
            );
            Assert.Contains($"File transfer endpoint returned HTTP {status}", read.Message);
            var write = await Assert.ThrowsAsync<HttpRequestException>(() =>
                client.Write(
                    "write",
                    Path.Combine(temp.Path, "target"),
                    "main",
                    false,
                    false,
                    128 * 1024,
                    default
                )
            );
            Assert.Contains($"File transfer endpoint returned HTTP {status}", write.Message);
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task Response_deadlines_do_not_impose_a_total_upload_deadline()
    {
        using var temp = new TempDirectory();
        var source = Path.Combine(temp.Path, "source");
        var large = Path.Combine(temp.Path, "large");
        await File.WriteAllBytesAsync(source, new byte[128 * 1024]);
        await using (var file = File.Create(large))
            file.SetLength(64 * 1024 * 1024);
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.WebHost.ConfigureKestrel(server => server.Limits.MaxRequestBodySize = null);
        await using var app = builder.Build();
        app.Map(
            "/node/transfer/{id}",
            async context =>
            {
                try
                {
                    var id = context.Request.RouteValues["id"]?.ToString();
                    if (id == "healthy")
                    {
                        await Task.Delay(TimeSpan.FromSeconds(32), context.RequestAborted);
                        await context.Request.Body.CopyToAsync(Stream.Null, context.RequestAborted);
                    }
                    else if (id == "healthy-download")
                    {
                        context.Response.ContentLength = 128 * 1024;
                        await context.Response.StartAsync(context.RequestAborted);
                        await context.Response.Body.FlushAsync(context.RequestAborted);
                        await Task.Delay(TimeSpan.FromSeconds(32), context.RequestAborted);
                        await context.Response.Body.WriteAsync(
                            new byte[128 * 1024],
                            context.RequestAborted
                        );
                    }
                    else
                    {
                        if (id == "stalled-download")
                        {
                            context.Response.ContentLength = 128 * 1024;
                            await context.Response.StartAsync(context.RequestAborted);
                            await context.Response.Body.FlushAsync(context.RequestAborted);
                        }
                        if (context.Request.Method == "PUT")
                            await context.Request.Body.CopyToAsync(
                                Stream.Null,
                                context.RequestAborted
                            );
                        await Task.Delay(Timeout.InfiniteTimeSpan, context.RequestAborted);
                    }
                }
                catch (OperationCanceledException)
                    when (context.RequestAborted.IsCancellationRequested) { }
            }
        );
        await app.StartAsync();
        var client = new NodeFileStream(
            new NodePaths(temp.Path),
            app.Urls.Single(),
            "node",
            "token"
        );
        using var fallback = new CancellationTokenSource(TimeSpan.FromSeconds(90));
        try
        {
            var clock = Stopwatch.StartNew();
            var read = Assert.ThrowsAsync<TimeoutException>(() =>
                client.Read("upload", source, "main", false, fallback.Token)
            );
            var write = Assert.ThrowsAsync<TimeoutException>(() =>
                client.Write(
                    "download",
                    Path.Combine(temp.Path, "target"),
                    "main",
                    false,
                    false,
                    128 * 1024,
                    fallback.Token
                )
            );
            var healthy = client.Read("healthy", large, "main", false, fallback.Token);
            var healthyDownload = client.Write(
                "healthy-download",
                Path.Combine(temp.Path, "healthy-target"),
                "main",
                false,
                false,
                128 * 1024,
                fallback.Token
            );
            var stalledDownload = Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                client.Write(
                    "stalled-download",
                    Path.Combine(temp.Path, "stalled-target"),
                    "main",
                    false,
                    false,
                    128 * 1024,
                    fallback.Token
                )
            );
            await Task.WhenAll(read, write, healthy, healthyDownload, stalledDownload);
            Assert.Contains("endpoint did not respond within 30 seconds", (await read).Message);
            Assert.Contains("endpoint did not respond within 30 seconds", (await write).Message);
            Assert.True(clock.Elapsed >= TimeSpan.FromSeconds(59));
            Assert.False(fallback.IsCancellationRequested);
            Assert.False(File.Exists(Path.Combine(temp.Path, "target")));
            Assert.False(File.Exists(Path.Combine(temp.Path, "stalled-target")));
            Assert.Equal(
                128 * 1024,
                new FileInfo(Path.Combine(temp.Path, "healthy-target")).Length
            );
        }
        finally
        {
            await app.StopAsync();
        }
    }
}
