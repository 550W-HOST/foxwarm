using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Asr;
using Foxwarm.Models;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

public sealed partial class AsrRoutesTests
{
    [Fact]
    public async Task Captured_config_honest_health_stream_capability_and_secret_exclusion()
    {
        await using var f = await Fixture.Create();
        var status = await Json(await f.Client.GetAsync("/api/asr/status"));
        Assert.True(status["configured"]!.GetValue<bool>());
        Assert.True(status["available"]!.GetValue<bool>());
        Assert.True(status["streamingSupported"]!.GetValue<bool>());
        Assert.DoesNotContain(Fixture.Key, status.ToJsonString());
        Assert.DoesNotContain(f.PeerUrl, status.ToJsonString());
        f.Health.Remove("ok");
        Assert.True(
            (await Json(await f.Client.GetAsync("/api/asr/status")))["available"]!.GetValue<bool>()
        ); // Legacy HTTP-OK health responses can omit the ok field.
        f.Health["streamingSupported"] = false;
        status = await Json(await f.Client.GetAsync("/api/asr/status"));
        Assert.True(status["available"]!.GetValue<bool>());
        Assert.False(status["streamingSupported"]!.GetValue<bool>());
        f.Health["ok"] = false;
        f.Health["error"] = Fixture.Key + "/private/path";
        status = await Json(await f.Client.GetAsync("/api/asr/status"));
        Assert.False(status["available"]!.GetValue<bool>());
        Assert.DoesNotContain(Fixture.Key, status.ToJsonString());
        Assert.DoesNotContain("/private/path", status.ToJsonString());
        File.WriteAllText(
            f.ConfigPath,
            "asrService:\n  enabled: false\n"
        );
        f.Health["ok"] = true;
        Assert.True(
            (await Json(await f.Client.GetAsync("/api/asr/status")))["configured"]!.GetValue<bool>()
        );
        Assert.All(f.ReceivedCookies, value => Assert.Empty(value));
        Assert.All(f.ReceivedOrigins, value => Assert.Empty(value));
    }

    [Theory]
    [InlineData("")]
    [InlineData("asrService:\n  enabled: false\n  url: https://service.example\n")]
    [InlineData("asrService:\n  url: ''\n")]
    [InlineData("asrService: 7\n")]
    [InlineData("asrService:\n  enabled: wrong\n  url: https://service.example\n")]
    [InlineData("asrService:\n  url: 12\n")]
    [InlineData("asrService:\n  url: https://service.example\n  key: 12\n")]
    [InlineData("asrService:\n  url: ftp://service.example\n")]
    public async Task Optional_missing_disabled_and_malformed_never_probe_or_break_main(
        string config
    )
    {
        await using var f = await Fixture.Create(_ => config);
        var status = await Json(await f.Client.GetAsync("/api/asr/status"));
        Assert.False(status["configured"]!.GetValue<bool>());
        Assert.False(status["available"]!.GetValue<bool>());
        Assert.Equal(0, f.Requests);
        using var audio = f.Audio(44);
        Assert.Equal(
            HttpStatusCode.ServiceUnavailable,
            (await f.Client.PostAsync("/api/asr/transcribe", audio)).StatusCode
        );
        Assert.Equal(
            "ready",
            (await Json(await f.Client.GetAsync("/health")))["status"]!.ToString()
        );
    }

    [Fact]
    public void Configured_administrator_remote_HTTP_is_supported_without_a_network_probe()
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, "state", "config.yaml");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        foreach (var url in new[] { "http://gpu.example:8091", "https://gpu.example/service" })
        {
            File.WriteAllText(path, "asrService:\n  url: " + url + "\n");
            using var proxy = new AsrProxy(
                new ModelConfiguration(temp.Path),
                CancellationToken.None
            );
            Assert.True(proxy.Configured);
        }
    }

    [Fact]
    public async Task Final_POST_forwards_real_multipart_fields_with_inclusive_limit_and_no_private_output()
    {
        await using var f = await Fixture.Create();
        var context = new string('c', 2500) + "LATEST-DRAFT-TAIL-SENTINEL";
        using var audio = f.Audio((int)AsrProxy.AudioLimit, "  " + context + "  ");
        audio.Add(new StringContent(" English "), "language");
        audio.Add(new StringContent(" 10 "), "segmentSeconds");
        var response = await f.Client.PostAsync("/api/asr/transcribe", audio);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        var result = await Json(response);
        Assert.Equal("scripted final", result["text"]!.ToString());
        Assert.Equal(AsrProxy.AudioLimit, f.AudioLength);
        Assert.Equal(context, f.Metadata["context"]!.ToString());
        Assert.Equal("English", f.Metadata["language"]!.ToString());
        Assert.Equal("10", f.Metadata["segmentSeconds"]!.ToString());
        Assert.DoesNotContain(Fixture.Key, result.ToJsonString());
        Assert.Null(result["privatePath"]);
        Assert.Null(result["credential"]);
        using var oversized = f.Audio((int)AsrProxy.AudioLimit + 1);
        Assert.Equal(
            HttpStatusCode.RequestEntityTooLarge,
            (await f.Client.PostAsync("/api/asr/transcribe", oversized)).StatusCode
        );
        Assert.Equal(1, f.Uploads);
    }

    [Fact]
    public async Task Final_POST_context_still_obeys_the_metadata_byte_budget()
    {
        await using var f = await Fixture.Create();
        using var audio = f.Audio(44, new string('c', AsrProxy.ControlLimit));
        var response = await f.Client.PostAsync("/api/asr/transcribe", audio);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(0, f.Uploads);
    }

    [Fact]
    public async Task Ordinary_body_limit_is_unchanged_and_bad_HTTP_mapping_does_not_expose_exception_details()
    {
        await using var f = await Fixture.Create();
        var response = await f.Client.PostAsync(
            "/api/auth",
            new StringContent(new string(' ', 3 * 1024 * 1024), Encoding.UTF8, "application/json")
        );
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
        var problem = await Json(response);
        Assert.Equal(413, problem["status"]!.GetValue<int>());
        Assert.DoesNotContain("2097152", problem.ToJsonString());
        Assert.DoesNotContain(Fixture.Key, problem.ToJsonString());
        Assert.Equal(0, f.Requests);
    }

    [Fact]
    public async Task Provider_wrong_body_oversize_redirect_and_errors_are_bounded_and_sanitized()
    {
        await using var f = await Fixture.Create();
        var cases = new[] { 0, 1, 2, 3 };
        foreach (var test in cases)
        {
            f.Upload = async context =>
            {
                if (test == 0)
                {
                    context.Response.StatusCode = 401;
                    await context.Response.WriteAsJsonAsync(
                        new { error = Fixture.Key + "/private/path" }
                    );
                }
                if (test == 1)
                    await context.Response.WriteAsync("not json: " + Fixture.Key);
                if (test == 2)
                    await context.Response.WriteAsync(
                        "{\"text\":\"" + new string('x', AsrProxy.OutputLimit + 1) + "\"}"
                    );
                if (test == 3)
                {
                    context.Response.StatusCode = 307;
                    context.Response.Headers.Location = f.PeerUrl + "/transcribe";
                }
            };
            using var audio = f.Audio(44);
            var response = await f.Client.PostAsync("/api/asr/transcribe", audio);
            Assert.False(response.IsSuccessStatusCode);
            var text = await response.Content.ReadAsStringAsync();
            Assert.DoesNotContain(Fixture.Key, text);
            Assert.DoesNotContain("/private/path", text);
        }
        Assert.Equal(cases.Length, f.Uploads);
    }

    [Fact]
    public async Task Client_abort_cancels_final_upstream_without_persisting_an_audio_attachment()
    {
        await using var f = await Fixture.Create();
        var admitted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancelled = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        f.Upload = async context =>
        {
            await context.Request.ReadFormAsync(context.RequestAborted);
            admitted.TrySetResult();
            try
            {
                await Task.Delay(Timeout.Infinite, context.RequestAborted);
            }
            catch (OperationCanceledException)
            {
                cancelled.TrySetResult();
            }
        };
        using var token = new CancellationTokenSource();
        using var audio = f.Audio(100000);
        var call = f.Client.PostAsync("/api/asr/transcribe", audio, token.Token);
        await admitted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        token.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await call);
        await cancelled.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.False(Directory.Exists(Path.Combine(f.Data, "state", "webui-uploads")));
        Assert.Equal(1, f.Uploads);
    }

    [Fact]
    public async Task Ordinary_audio_attachment_above_ASR_limit_keeps_separate_file_authority_without_transcription()
    {
        await using var f = await Fixture.Create();
        using var file = new MultipartFormDataContent();
        using var bytes = new ByteArrayContent(new byte[AsrProxy.AudioLimit + 1]);
        bytes.Headers.ContentType = new("audio/wav");
        file.Add(bytes, "file", "ordinary.wav");
        var response = await f.Client.PostAsync("/api/upload", file);
        Assert.True(response.IsSuccessStatusCode);
        var saved = await Json(response);
        Assert.Equal("audio/wav", saved["mimeType"]!.ToString());
        var path = saved["path"]!.ToString();
        try
        {
            Assert.Equal(AsrProxy.AudioLimit + 1, new FileInfo(path).Length);
        }
        finally
        {
            File.Delete(path);
        }
        Assert.Equal(0, f.Requests);
        Assert.Equal(0, f.Uploads);
    }

    [Fact]
    public async Task Prefix_cookie_origin_Bearer_and_enablefalse_reuse_normal_main_auth()
    {
        await using (var f = await Fixture.Create(prefix: true))
        {
            Assert.True((await f.Client.GetAsync("/prefix/api/asr/status")).IsSuccessStatusCode);
            f.Client.DefaultRequestHeaders.Authorization = null;
            Assert.Equal(
                HttpStatusCode.Unauthorized,
                (await f.Client.GetAsync("/api/asr/status")).StatusCode
            );
            f.Client.DefaultRequestHeaders.Add("Cookie", "foxwarm_token=" + Fixture.Token);
            Assert.True((await f.Client.GetAsync("/api/asr/status")).IsSuccessStatusCode);
            f.Client.DefaultRequestHeaders.Add("Origin", "https://foreign.example");
            Assert.True((await f.Client.GetAsync("/api/asr/status")).IsSuccessStatusCode);
            f.Client.DefaultRequestHeaders.Remove("Origin");
            f.Client.DefaultRequestHeaders.Add("Origin", "https://public.example");
            Assert.True((await f.Client.GetAsync("/prefix/api/asr/status")).IsSuccessStatusCode);
        }
        await using (var f = await Fixture.Create(enabled: false))
        {
            Assert.Equal(
                HttpStatusCode.NotFound,
                (await f.Client.GetAsync("/api/asr/status")).StatusCode
            );
            using var audio = f.Audio(44);
            Assert.Equal(
                HttpStatusCode.NotFound,
                (await f.Client.PostAsync("/api/asr/transcribe", audio)).StatusCode
            );
            Assert.Equal(0, f.Requests);
        }
    }
}
