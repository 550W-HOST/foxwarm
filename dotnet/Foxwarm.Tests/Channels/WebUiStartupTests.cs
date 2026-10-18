using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class WebUiStartupTests
{
    private sealed class Host : IAsyncDisposable
    {
        internal readonly TempDirectory Temp = new();
        internal readonly int Port = FreePort();
        internal string Data => Path.Combine(Temp.Path, "data");
        internal string Work => Path.Combine(Temp.Path, "work");
        internal string TokenPath => Path.Combine(Data, "state", "token");
        internal string ConfigPath => Path.Combine(Data, "state", "config.yaml");
        internal string Dist => Path.Combine(Temp.Path, "dist");
        internal readonly string Token = "opaque-fixture-%-credential";
        internal Process Process = null!;
        private Task<string>? stdout,
            stderr;
        private TaskCompletionSource<string> listening = null!;
        private bool ownedListener;
        internal HttpClient Client = null!;

        internal static int FreePort()
        {
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            listener.Stop();
            return port;
        }

        internal Host()
        {
            Directory.CreateDirectory(Path.GetDirectoryName(TokenPath)!);
            Directory.CreateDirectory(Work);
            Directory.CreateDirectory(Path.Combine(Dist, "assets"));
            File.WriteAllText(
                Path.Combine(Dist, "index.html"),
                "<html><head></head><body>authenticated-app-fixture</body></html>"
            );
            File.WriteAllText(
                Path.Combine(Dist, "assets", "fixture.js"),
                "export const fixture = true;"
            );
            File.WriteAllText(ConfigPath, $"bot:\n  httpPort: {Port}\nllm:\n  maxOutput: 713\n");
            Client = new HttpClient(new HttpClientHandler { UseCookies = false })
            {
                BaseAddress = new Uri("http://127.0.0.1:" + Port),
                Timeout = TimeSpan.FromSeconds(20),
            };
        }

        internal void Start(Dictionary<string, string?>? changes = null)
        {
            var root = Environment.GetEnvironmentVariable("DOTNET_ROOT");
            var info = new ProcessStartInfo(root is null ? "dotnet" : Path.Combine(root, "dotnet"))
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            info.ArgumentList.Add(typeof(HttpServer).Assembly.Location);
            foreach (
                var key in new[]
                {
                    "FOXWARM_EXPERIMENT_PORT",
                    "FOXWARM_EXPERIMENT_BIND_ADDRESS",
                    "FOXWARM_PUBLIC_BASE_URL",
                    "FOXWARM_VSCODE_WEB_WEBVIEW_ORIGIN",
                }
            )
                info.Environment.Remove(key);
            info.Environment["FOXWARM_DATA_DIR"] = Data;
            info.Environment["FOXWARM_CONFIG_PATH"] = ConfigPath;
            info.Environment["FOXWARM_EXPERIMENT_TOOL_ROOT"] = Work;
            info.Environment["FOXWARM_EXPERIMENT_WEBUI_DIST"] = Dist;
            foreach (var (key, value) in changes ?? [])
            {
                if (value is null)
                    info.Environment.Remove(key);
                else
                    info.Environment[key] = value;
            }
            Process?.Dispose();
            ownedListener = false;
            listening = new(TaskCreationOptions.RunContinuationsAsynchronously);
            Process = Process.Start(info)!;
            stdout = ReadOutput();
            stderr = Process.StandardError.ReadToEndAsync();
        }

        private async Task<string> ReadOutput()
        {
            var output = new StringBuilder();
            while (await Process.StandardOutput.ReadLineAsync() is { } line)
            {
                output.AppendLine(line);
                if (line.StartsWith("Main HTTP listening: ", StringComparison.Ordinal))
                    listening.TrySetResult(line[21..]);
            }
            return output.ToString();
        }

        internal async Task Ready(string? token = null)
        {
            var exited = Process.WaitForExitAsync();
            await Task.WhenAny(listening.Task, exited).WaitAsync(TimeSpan.FromSeconds(20));
            if (Process.HasExited || !listening.Task.IsCompletedSuccessfully)
                throw new InvalidOperationException(await Output());
            Assert.Equal(
                Client.BaseAddress!.GetLeftPart(UriPartial.Authority),
                await listening.Task
            );
            ownedListener = true;
            Client.DefaultRequestHeaders.Authorization = new("Bearer", token ?? Token);
            var response = await Client.GetAsync("/health");
            Assert.True(response.IsSuccessStatusCode);
            Assert.Equal(
                "ready",
                (await response.Content.ReadFromJsonAsync<JsonObject>())?[
                    "status"
                ]?.GetValue<string>()
            );
        }

        internal async Task<string> Output() => await stdout! + await stderr!;

        internal async Task Failed()
        {
            await Process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20));
            Assert.NotEqual(0, Process.ExitCode);
        }

        internal async Task Stop()
        {
            Assert.True(ownedListener);
            Assert.False(Process.HasExited);
            Assert.Equal(
                HttpStatusCode.Accepted,
                (await Client.PostAsync("/admin/shutdown", null)).StatusCode
            );
            await Process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20));
            Assert.Equal(0, Process.ExitCode);
        }

        public async ValueTask DisposeAsync()
        {
            Client.Dispose();
            if (Process is not null)
            {
                if (!Process.HasExited)
                {
                    Process.Kill(true);
                    await Process.WaitForExitAsync();
                }
                Process.Dispose();
            }
            Temp.Dispose();
        }
    }

    [Fact]
    public async Task Setup_http_saves_forward_real_installation_outcomes_and_preserve_existing_payloads()
    {
        await using var h = new Host();
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        h.Start();
        await h.Ready();
        var raw =
            $"bot:\n  httpPort: {h.Port}\nllm:\n  maxOutput: 714\nchannels:\n  webui: {{enabled: false}}\naccess:\n  identities: {{}}\n";
        var configResponse = await h.Client.PostAsJsonAsync(
            "/api/setup/config",
            new { yaml = raw }
        );
        Assert.Equal(HttpStatusCode.OK, configResponse.StatusCode);
        var config = (await configResponse.Content.ReadFromJsonAsync<JsonObject>())!;
        Assert.True(config["success"]!.GetValue<bool>());
        Assert.True(config["saved"]!.GetValue<bool>());
        Assert.Equal("config", config["target"]!.GetValue<string>());
        Assert.Equal(
            new[] { "access.identities", "access.surfaces.mcp" },
            config["applied"]!.AsArray().Select(value => value!.GetValue<string>())
        );
        Assert.Equal(
            new[] { "channels" },
            config["notApplied"]!.AsArray().Select(v => v!.GetValue<string>())
        );
        Assert.Contains(
            "llm",
            config["restartRequired"]!.AsArray().Select(v => v!.GetValue<string>())
        );
        Assert.Contains(
            "channels.webui",
            config["restartRequired"]!.AsArray().Select(v => v!.GetValue<string>())
        );
        Assert.Equal(h.ConfigPath, config["configPath"]!.GetValue<string>());
        Assert.Equal(raw, config["rawYaml"]!.GetValue<string>());
        Assert.Equal(1, config["channelCount"]!.GetValue<int>());
        Assert.False(config["reload"]!["available"]!.GetValue<bool>());
        Assert.Equal(raw, await File.ReadAllTextAsync(h.ConfigPath));

        var channelResponse = await h.Client.PostAsJsonAsync(
            "/api/setup/channels",
            new { channels = new { webui = new { enabled = true } } }
        );
        Assert.Equal(HttpStatusCode.OK, channelResponse.StatusCode);
        var channels = (await channelResponse.Content.ReadFromJsonAsync<JsonObject>())!;
        Assert.True(channels["success"]!.GetValue<bool>());
        Assert.True(channels["saved"]!.GetValue<bool>());
        Assert.Equal("config", channels["target"]!.GetValue<string>());
        Assert.Equal(
            new[] { "access.identities", "access.surfaces.mcp" },
            channels["applied"]!.AsArray().Select(value => value!.GetValue<string>())
        );
        Assert.Equal(
            new[] { "channels" },
            channels["notApplied"]!.AsArray().Select(v => v!.GetValue<string>())
        );
        Assert.Contains(
            "channels.webui",
            channels["restartRequired"]!.AsArray().Select(v => v!.GetValue<string>())
        );
        Assert.NotNull(channels["channelsYaml"]);
        Assert.Equal(1, channels["channelCount"]!.GetValue<int>());
        Assert.False(channels["reload"]!["available"]!.GetValue<bool>());
        Assert.Equal(
            714d,
            ConfigurationYaml.Parse(await File.ReadAllTextAsync(h.ConfigPath), "config")["llm"]![
                "maxOutput"
            ]!.GetValue<double>()
        );
        // A saved disabled WebUI setting does not unmount the startup-captured administrator route.
        Assert.Equal(
            "admin",
            (await h.Client.GetFromJsonAsync<JsonObject>("/api/auth/session"))![
                "role"
            ]!.GetValue<string>()
        );

        var modelsRaw =
            "default: local/wire\nproviders:\n  local: {providerType: openai-responses, baseUrl: 'http://127.0.0.1:1', models: [wire]}\n";
        var modelsResponse = await h.Client.PostAsJsonAsync(
            "/api/setup/models",
            new { yaml = modelsRaw }
        );
        Assert.Equal(HttpStatusCode.OK, modelsResponse.StatusCode);
        var models = (await modelsResponse.Content.ReadFromJsonAsync<JsonObject>())!;
        Assert.True(models["success"]!.GetValue<bool>());
        Assert.True(models["saved"]!.GetValue<bool>());
        Assert.Equal("models", models["target"]!.GetValue<string>());
        Assert.Equal(
            new[] { "models" },
            models["applied"]!.AsArray().Select(v => v!.GetValue<string>())
        );
        Assert.Empty(models["notApplied"]!.AsArray());
        Assert.Empty(models["restartRequired"]!.AsArray());
        Assert.NotNull(models["models"]);
        Assert.NotNull(models["payload"]);
        Assert.Equal(
            modelsRaw,
            await File.ReadAllTextAsync(Path.Combine(h.Data, "state", "models.yaml"))
        );
        await h.Stop();
    }

    [Fact]
    public async Task Actual_normal_startup_creates_private_token_and_reuses_opaque_existing_token_across_restart()
    {
        await using var h = new Host();
        h.Start();
        using (var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(20)))
        {
            while (!File.Exists(h.TokenPath) && !h.Process.HasExited)
                await Task.Delay(25, deadline.Token);
        }
        if (h.Process.HasExited)
            throw new InvalidOperationException(await h.Output());
        var fresh = await File.ReadAllTextAsync(h.TokenPath);
        Assert.Matches("^[0-9a-f]{64}$", fresh);
        if (!OperatingSystem.IsWindows())
            Assert.Equal(
                UnixFileMode.UserRead | UnixFileMode.UserWrite,
                File.GetUnixFileMode(h.TokenPath)
            );
        await h.Ready(fresh);
        await h.Stop();
        await File.WriteAllTextAsync(h.TokenPath, "  " + h.Token + "\n");
        h.Start();
        await h.Ready();
        await h.Stop();
        Assert.Equal("  " + h.Token + "\n", await File.ReadAllTextAsync(h.TokenPath));
    }

    [Fact]
    public async Task Actual_invalid_secret_evidence_is_not_replaced()
    {
        await using var h = new Host();
        foreach (
            var bytes in new[]
            {
                Encoding.UTF8.GetBytes(" \n"),
                new byte[] { 0xff, 0xfe, 0xff },
                [],
            }
        )
        {
            await File.WriteAllBytesAsync(h.TokenPath, bytes);
            h.Start();
            await h.Failed();
            Assert.Equal(bytes, await File.ReadAllBytesAsync(h.TokenPath));
        }
        if (!OperatingSystem.IsWindows())
        {
            await File.WriteAllTextAsync(h.TokenPath, h.Token);
            File.SetUnixFileMode(h.TokenPath, UnixFileMode.None);
            h.Start();
            await h.Failed();
            File.SetUnixFileMode(h.TokenPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            Assert.Equal(h.Token, await File.ReadAllTextAsync(h.TokenPath));
        }
        File.Delete(h.TokenPath);
        Directory.CreateDirectory(h.TokenPath);
        h.Start();
        await h.Failed();
        Assert.True(Directory.Exists(h.TokenPath));
    }

    [Fact]
    public async Task Actual_disabled_WebUI_keeps_core_health_but_mounts_no_browser_or_data_routes()
    {
        await using var h = new Host();
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        await File.WriteAllTextAsync(
            h.ConfigPath,
            $"bot:\n  httpPort: {h.Port}\n  enableWebUI: false\n"
        );
        h.Start();
        await h.Ready();
        foreach (
            var route in new[]
            {
                "/",
                "/login.html",
                "/assets/fixture.js",
                "/api/sessions",
                "/api/auth",
                "/api/blobs/invalid",
                "/download",
                "/vscode-web/",
                "/api/vscode-web/fs/workspace-roots",
            }
        )
            Assert.Equal(HttpStatusCode.NotFound, (await h.Client.GetAsync(route)).StatusCode);
        Assert.Equal(
            HttpStatusCode.NotFound,
            (await h.Client.PostAsJsonAsync("/api/auth", new { token = h.Token })).StatusCode
        );
        await h.Stop();
    }

    [Fact]
    public async Task Actual_declared_origin_mount_cookie_compatibility_and_generic_server_login()
    {
        await using var h = new Host();
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        var origin = "http://127.0.0.1:" + h.Port;
        h.Start(new() { ["FOXWARM_PUBLIC_BASE_URL"] = origin + "/public/main/" });
        await h.Ready();
        h.Client.DefaultRequestHeaders.Authorization = null;
        Assert.Contains("id=\"token\"", await h.Client.GetStringAsync("/public/main/"));
        Assert.Contains("id=\"token\"", await h.Client.GetStringAsync("/assets/fixture.js"));
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await h.Client.GetAsync("/public/main/api/sessions")).StatusCode
        );
        var login = await h.Client.PostAsJsonAsync(
            "/public/main/api/auth",
            new { token = h.Token }
        );
        Assert.True(login.IsSuccessStatusCode);
        var cookie = Assert.Single(login.Headers.GetValues("Set-Cookie"));
        Assert.Contains("path=/public/main/", cookie);
        Assert.Contains("httponly", cookie);
        Assert.Contains("samesite=strict", cookie);
        Assert.DoesNotContain("secure", cookie);
        var derived = Convert
            .ToHexString(
                HMACSHA256.HashData(
                    Encoding.UTF8.GetBytes(h.Token),
                    Encoding.UTF8.GetBytes("foxwarm-experiment-cookie-v1")
                )
            )
            .ToLowerInvariant();
        foreach (
            var value in new[]
            {
                Uri.EscapeDataString(h.Token),
                derived,
                "bad; foxwarm_token=" + derived,
                "bad; foxwarm_token=" + Uri.EscapeDataString(h.Token),
            }
        )
        {
            h.Client.DefaultRequestHeaders.Remove("Cookie");
            h.Client.DefaultRequestHeaders.Add("Cookie", "foxwarm_token=" + value);
            var html = await h.Client.GetStringAsync("/public/main/");
            Assert.Contains("name=\"foxwarm-host\" content=\"dotnet\"", html);
            Assert.Contains("authenticated-app-fixture", html);
            Assert.True((await h.Client.GetAsync("/public/main/api/sessions")).IsSuccessStatusCode);
        }
        h.Client.DefaultRequestHeaders.Remove("Cookie");
        h.Client.DefaultRequestHeaders.Add("Cookie", "foxwarm_token=bad");
        h.Client.DefaultRequestHeaders.Authorization = new("Bearer", h.Token);
        Assert.True((await h.Client.GetAsync("/api/sessions")).IsSuccessStatusCode);
        foreach (
            var otherOrigin in new[]
            {
                "null",
                "invalid",
                "https://foreign.invalid",
                origin + "/",
                origin,
            }
        )
        {
            h.Client.DefaultRequestHeaders.Remove("Origin");
            h.Client.DefaultRequestHeaders.Add("Origin", otherOrigin);
            Assert.True((await h.Client.GetAsync("/public/main/api/sessions")).IsSuccessStatusCode);
        }
        await h.Stop();
        h.Start(new() { ["FOXWARM_PUBLIC_BASE_URL"] = origin + "/public/main/" });
        await h.Ready();
        h.Client.DefaultRequestHeaders.Authorization = null;
        h.Client.DefaultRequestHeaders.Remove("Cookie");
        h.Client.DefaultRequestHeaders.Add("Cookie", "foxwarm_token=" + derived);
        Assert.True((await h.Client.GetAsync("/public/main/api/sessions")).IsSuccessStatusCode);
        h.Client.DefaultRequestHeaders.Authorization = new("Bearer", h.Token);
        await h.Stop();
    }

    [Fact]
    public async Task Actual_authenticated_user_task_routes_support_create_assign_release_and_comment()
    {
        await using var h = new Host();
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        h.Start();
        await h.Ready();

        var description = new string('d', 20000);
        var create = await h.Client.PostAsJsonAsync(
            "/api/tasks",
            new { title = "HTTP user task", description }
        );
        Assert.Equal(HttpStatusCode.Created, create.StatusCode);
        var created = await create.Content.ReadFromJsonAsync<JsonObject>();
        var taskId = created!["task"]!["id"]!.GetValue<string>();
        Assert.Equal("user", created["task"]!["createdByKind"]!.GetValue<string>());
        Assert.Equal(20000, created["task"]!["description"]!.GetValue<string>().Length);

        var session = await h.Client.PostAsJsonAsync(
            "/api/sessions",
            new { agentId = "main", sessionId = "task-owner" }
        );
        Assert.True(session.IsSuccessStatusCode, await session.Content.ReadAsStringAsync());
        var sessionPayload = await session.Content.ReadFromJsonAsync<JsonObject>();
        var ownerId = sessionPayload!["sessionId"]!.GetValue<string>();
        var assign = await h.Client.PostAsJsonAsync(
            $"/api/tasks/{taskId}/assign",
            new { ownerSessionId = ownerId }
        );
        Assert.True(
            assign.IsSuccessStatusCode,
            $"{assign.StatusCode}: {await assign.Content.ReadAsStringAsync()}"
        );
        var assigned = await assign.Content.ReadFromJsonAsync<JsonObject>();
        Assert.Equal(ownerId, assigned!["task"]!["ownerSessionId"]!.GetValue<string>());

        var comment = await h.Client.PostAsJsonAsync(
            $"/api/tasks/{taskId}/comments",
            new { note = "user comment" }
        );
        Assert.Equal(HttpStatusCode.OK, comment.StatusCode);
        var details = await (
            await h.Client.GetAsync($"/api/tasks/{taskId}")
        ).Content.ReadFromJsonAsync<JsonObject>();
        Assert.Contains(
            details!["notes"]!.AsArray(),
            note =>
                note?["authorKind"]?.GetValue<string>() == "user"
                && note["text"]?.GetValue<string>() == "user comment"
        );

        var release = await h.Client.PostAsJsonAsync(
            $"/api/tasks/{taskId}/assign",
            new { ownerSessionId = (string?)null }
        );
        Assert.Equal(HttpStatusCode.OK, release.StatusCode);
        var released = await release.Content.ReadFromJsonAsync<JsonObject>();
        Assert.Null(released!["task"]!["ownerSessionId"]);

        await h.Stop();
    }

    [Fact]
    public async Task Actual_login_from_any_origin_with_valid_token_sets_cookie_for_later_requests()
    {
        await using var h = new Host();
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        h.Start(new() { ["FOXWARM_PUBLIC_BASE_URL"] = "https://declared.example/main/" });
        await h.Ready();
        h.Client.DefaultRequestHeaders.Authorization = null;
        h.Client.DefaultRequestHeaders.Add("Origin", "http://127.0.0.1:" + h.Port);
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await h.Client.GetAsync("/api/sessions")).StatusCode
        );
        var login = await h.Client.PostAsJsonAsync("/api/auth", new { token = h.Token });
        Assert.True(login.IsSuccessStatusCode);
        var cookie = Assert.Single(login.Headers.GetValues("Set-Cookie"));
        Assert.Contains("secure", cookie);
        h.Client.DefaultRequestHeaders.Remove("Origin");
        h.Client.DefaultRequestHeaders.Add("Origin", "https://foreign.invalid");
        h.Client.DefaultRequestHeaders.Add("Cookie", cookie.Split(';')[0]);
        Assert.True((await h.Client.GetAsync("/api/sessions")).IsSuccessStatusCode);
        await h.Stop();
    }

    [Fact]
    public async Task Owned_bind_failure_prevents_readiness_and_cleanup_requests()
    {
        await using var h = new Host();
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        using var occupied = new TcpListener(IPAddress.Loopback, h.Port);
        occupied.Start();
        h.Start();
        await Assert.ThrowsAsync<InvalidOperationException>(() => h.Ready());
        Assert.True(h.Process.HasExited);
        Assert.False(occupied.Pending());
        await Assert.ThrowsAnyAsync<Exception>(() => h.Stop());
        Assert.False(occupied.Pending());
    }

    [Fact]
    public async Task Actual_invalid_startup_inputs_fail_without_touching_existing_secret_and_port_override_wins()
    {
        await using var h = new Host();
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        foreach (
            var address in new[]
            {
                "ftp://example/",
                "http://user:pass@example/",
                "http://example/?query",
                "http://example/#fragment",
                "http://example/#",
                "http://example/?",
                "http://@example/",
                "http://*.example/",
                "not a url",
            }
        )
        {
            h.Start(new() { ["FOXWARM_PUBLIC_BASE_URL"] = address });
            await h.Failed();
            Assert.Equal(h.Token, await File.ReadAllTextAsync(h.TokenPath));
        }
        await File.WriteAllTextAsync(h.ConfigPath, "bot:\n  httpPort: 1\n");
        h.Start(new() { ["FOXWARM_EXPERIMENT_PORT"] = h.Port.ToString() });
        await h.Ready();
        await h.Stop();
        await File.WriteAllTextAsync(h.ConfigPath, "bot:\n  enableWebUI: invalid\n");
        h.Start();
        await h.Failed();
    }
}
