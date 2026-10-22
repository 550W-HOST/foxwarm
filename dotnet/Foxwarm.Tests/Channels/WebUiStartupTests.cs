using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed partial class WebUiStartupTests
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
            info.Environment.Remove("FOXWARM_VSCODE_WEB_WEBVIEW_ORIGIN");
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

        internal async Task Ready(string? token = null, bool quiet = false)
        {
            if (!quiet)
            {
                var exited = Process.WaitForExitAsync();
                await Task.WhenAny(listening.Task, exited).WaitAsync(TimeSpan.FromSeconds(20));
                if (Process.HasExited || !listening.Task.IsCompletedSuccessfully)
                    throw new InvalidOperationException(await Output());
                Assert.Equal(
                    "http://0.0.0.0:" + Port,
                    await listening.Task
                );
            }
            else
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
                while (true)
                {
                    if (Process.HasExited)
                        throw new InvalidOperationException(await Output());
                    try
                    {
                        using var ping = await Client.GetAsync("/health", timeout.Token);
                        if (ping.StatusCode is HttpStatusCode.OK or HttpStatusCode.Unauthorized)
                            break;
                    }
                    catch (HttpRequestException) { }
                    await Task.Delay(25, timeout.Token);
                }
            }
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

        internal Task<string> StandardOutput() => stdout!;

        internal Task<string> ErrorOutput() => stderr!;

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

    [Theory]
    [InlineData("FOXWARM_SYNC_FILE_LOG")]
    [InlineData("FOXWARM_NO_CONSOLE_LOG")]
    [InlineData("FOXWARM_LOG_STDERR")]
    public async Task Real_Main_file_logging_preserves_console_flags_and_natural_final_record(
        string flag
    )
    {
        await using var h = new Host();
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        h.Start(new() { [flag] = "1" });
        await h.Ready(quiet: true);
        await h.Stop();
        var text = await File.ReadAllTextAsync(
            Path.Combine(h.Data, "state", "logs", "foxwarm.log")
        );
        if (flag == "FOXWARM_SYNC_FILE_LOG")
        {
            var records = text.TrimEnd()
                .Split('\n')
                .Select(line => JsonNode.Parse(line)!)
                .ToArray();
            Assert.All(records, record => Assert.True(record["time"]!.GetValue<long>() > 0));
            Assert.Equal("Main stopped.", records[^1]["msg"]!.ToString());
        }
        else
            Assert.EndsWith("Main stopped.\n", text);
        var output = await h.StandardOutput();
        var errors = await h.ErrorOutput();
        Assert.DoesNotContain("Main HTTP listening:", output);
        if (flag == "FOXWARM_LOG_STDERR")
            Assert.Contains("Main HTTP listening:", errors);
        else
            Assert.DoesNotContain("Main HTTP listening:", errors);
    }

    [Fact]
    public async Task Diagnostic_write_failure_does_not_fail_a_committed_http_effect_or_normal_shutdown()
    {
        if (!OperatingSystem.IsLinux())
            return; // Linux's ordinary failing character device.
        await using var h = new Host();
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        var directory = Path.Combine(h.Data, "state", "logs");
        Directory.CreateDirectory(directory);
        File.CreateSymbolicLink(Path.Combine(directory, "foxwarm.log"), "/dev/full");
        h.Start();
        await h.Ready();
        var response = await h.Client.PostAsJsonAsync("/api/sessions", new { });
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        var created = await response.Content.ReadFromJsonAsync<JsonObject>();
        Assert.NotNull(created?["id"] ?? created?["sessionId"] ?? created?["session"]?["id"]);
        await h.Stop();
        Assert.NotEmpty(await h.ErrorOutput());
    }

    [Fact]
    public async Task Main_produces_its_configured_file_and_authenticated_logs_reconnect_on_the_existing_socket()
    {
        await using var h = new Host();
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        await File.WriteAllTextAsync(
            h.ConfigPath,
            "bot: {name: producer, httpPort: "
                + h.Port
                + ", enableTUI: true}\naccess:\n  identities: {alice: {token: synthetic-alice, surfaces: {webui: {sessions: [chat]}}}}\n"
        );
        h.Start();
        await h.Ready();
        var destination = Path.Combine(h.Data, "state", "logs", "producer.log");
        var produced = await File.ReadAllTextAsync(destination);
        Assert.Matches(
            @"\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [+-]\d{4}\] INFO: Main HTTP listening:",
            produced
        );
        Assert.Contains(" ERROR: ", produced);
        Assert.True(
            !produced.Contains("\u001b"),
            System.Text.Json.JsonSerializer.Serialize(produced)
        );
        using (var denied = new HttpClient { BaseAddress = h.Client.BaseAddress })
        {
            Assert.Equal(
                HttpStatusCode.Unauthorized,
                (await denied.GetAsync("/api/webui/logs")).StatusCode
            );
            denied.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-alice");
            Assert.Equal(
                HttpStatusCode.Forbidden,
                (await denied.GetAsync("/api/webui/logs")).StatusCode
            );
        }
        foreach (
            var query in new[]
            {
                "path=other",
                "offset=1&offset=2",
                "direction=before",
                "offset=9007199254740992",
                "time=invalid&fileId=stale",
            }
        )
            Assert.Equal(
                HttpStatusCode.BadRequest,
                (await h.Client.GetAsync("/api/webui/logs?" + query)).StatusCode
            );
        var initial = (await h.Client.GetFromJsonAsync<JsonObject>("/api/webui/logs"))!["window"]!;
        Assert.Contains("Main HTTP listening:", initial["text"]!.ToString());
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        async Task<System.Net.WebSockets.ClientWebSocket> Connect(string token)
        {
            var socket = new System.Net.WebSockets.ClientWebSocket();
            socket.Options.SetRequestHeader("Authorization", "Bearer " + token);
            await socket.ConnectAsync(
                new Uri(
                    h.Client.BaseAddress!.ToString().Replace("http:", "ws:") + "api/webui/stream"
                ),
                timeout.Token
            );
            return socket;
        }
        async Task Subscribe(
            System.Net.WebSockets.ClientWebSocket socket,
            long revision,
            string id,
            JsonNode? cursor = null
        )
        {
            var frame = new JsonObject
            {
                ["type"] = "set-subscriptions",
                ["revision"] = revision,
                ["sessionListActive"] = false,
                ["sessionListIds"] = new JsonArray(),
                ["sessionIds"] = new JsonArray(),
                ["logs"] = new JsonObject { ["id"] = id },
            };
            if (cursor is not null)
                frame["logs"]!["cursor"] = cursor.DeepClone();
            await socket.SendAsync(
                Encoding.UTF8.GetBytes(frame.ToJsonString()),
                System.Net.WebSockets.WebSocketMessageType.Text,
                true,
                timeout.Token
            );
        }
        async Task<JsonObject> Frame(System.Net.WebSockets.ClientWebSocket socket, string type)
        {
            while (true)
            {
                using var body = new MemoryStream();
                var buffer = new byte[8192];
                System.Net.WebSockets.WebSocketReceiveResult part;
                do
                {
                    part = await socket.ReceiveAsync(buffer, timeout.Token);
                    body.Write(buffer, 0, part.Count);
                } while (!part.EndOfMessage);
                var frame = JsonNode.Parse(body.ToArray())!.AsObject();
                if (frame["type"]!.ToString() == type)
                    return frame;
            }
        }
        using (var scoped = await Connect("synthetic-alice"))
        {
            await Subscribe(scoped, 1, "denied");
            await Frame(scoped, "protocol-error");
        }
        JsonObject frontier;
        using (var socket = await Connect(h.Token))
        {
            await Subscribe(socket, 1, "logical");
            var snapshot = await Frame(socket, "logs-snapshot");
            await File.AppendAllTextAsync(destination, "external writer\n");
            var delta = await Frame(socket, "logs-delta");
            Assert.Equal(
                snapshot["window"]!["endOffset"]!.ToString(),
                delta["window"]!["startOffset"]!.ToString()
            );
            Assert.Equal("external writer\n", delta["window"]!["text"]!.ToString());
            frontier = new JsonObject
            {
                ["fileId"] = delta["window"]!["fileId"]!.DeepClone(),
                ["offset"] = delta["window"]!["endOffset"]!.DeepClone(),
            };
            await Subscribe(socket, 2, "logical");
            await Frame(socket, "subscriptions-applied");
            await File.AppendAllTextAsync(destination, "same lifetime\n");
            var next = await Frame(socket, "logs-delta");
            Assert.Equal("same lifetime\n", next["window"]!["text"]!.ToString());
            frontier["offset"] = next["window"]!["endOffset"]!.DeepClone();
            socket.Abort();
        }
        await File.AppendAllTextAsync(destination, "disconnected\n");
        // Source accepts safe integer values regardless of JSON numeric spelling.
        frontier["offset"] = JsonNode.Parse(frontier["offset"]!.ToString() + ".0");
        using (var resumed = await Connect(h.Token))
        {
            await Subscribe(resumed, 1, "resumed", frontier);
            Assert.Equal(
                "disconnected\n",
                (await Frame(resumed, "logs-delta"))["window"]!["text"]!.ToString()
            );
            File.Move(destination, destination + ".old");
            await File.WriteAllTextAsync(destination, "replacement\n");
            await Frame(resumed, "logs-reset");
            Assert.Equal(
                HttpStatusCode.Conflict,
                (
                    await h.Client.GetAsync(
                        "/api/webui/logs?direction=after&offset=0&fileId="
                            + Uri.EscapeDataString(frontier["fileId"]!.ToString())
                    )
                ).StatusCode
            );
            resumed.Abort();
        }
        await h.Stop();
        var final = await File.ReadAllTextAsync(destination + ".old");
        Assert.StartsWith(produced + "external writer\nsame lifetime\ndisconnected\n", final);
        Assert.EndsWith("Main stopped.\n", final);
        Assert.Contains("Main stopped.", await h.Output());
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
            new[] { "access.identities", "access.surfaces.mcp", "channels" },
            config["applied"]!.AsArray().Select(value => value!.GetValue<string>())
        );
        Assert.Equal(
            new[] { "channels.webui" },
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
        Assert.True(config["reload"]!["available"]!.GetValue<bool>());
        Assert.Equal(raw, await File.ReadAllTextAsync(h.ConfigPath));

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
        await File.AppendAllTextAsync(h.ConfigPath, "url: " + origin + "/public/main/\n");
        h.Start();
        await h.Ready();
        h.Client.DefaultRequestHeaders.Authorization = null;
        Assert.Contains("id=\"token\"", await h.Client.GetStringAsync("/public/main/"));
        Assert.Contains("id=\"token\"", await h.Client.GetStringAsync("/assets/fixture.js"));
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await h.Client.GetAsync("/public/main/api/sessions")).StatusCode
        );
        foreach (var prefix in new[] { "", "/public/main" })
        {
            var login = await h.Client.PostAsJsonAsync(
                prefix + "/api/auth",
                new { token = h.Token }
            );
            Assert.True(login.IsSuccessStatusCode);
            Assert.False(login.Headers.Contains("Set-Cookie"));
        }
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
        h.Start();
        await h.Ready();
        h.Client.DefaultRequestHeaders.Authorization = null;
        h.Client.DefaultRequestHeaders.Remove("Cookie");
        h.Client.DefaultRequestHeaders.Add("Cookie", "foxwarm_token=" + derived);
        Assert.True((await h.Client.GetAsync("/public/main/api/sessions")).IsSuccessStatusCode);
        h.Client.DefaultRequestHeaders.Authorization = new("Bearer", h.Token);
        await h.Stop();
    }

    [Fact]
    public async Task WebUI_created_root_precedes_ranked_siblings_beyond_the_initial_window_and_survives_restart()
    {
        await using var h = new Host();
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        await File.AppendAllTextAsync(h.ConfigPath, "vector: false\n");
        h.Start();
        await h.Ready();
        var ids = new List<string>();
        for (var index = 0; index < 53; index++)
        {
            var response = await h.Client.PostAsJsonAsync(
                "/api/sessions",
                new { agentId = "main", sessionId = "ranked-" + index }
            );
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var requested = (await response.Content.ReadFromJsonAsync<JsonObject>())![
                "sessionId"
            ]!.GetValue<string>();
            Assert.Equal("ranked-" + index, requested);
            ids.Add(requested);
        }
        foreach (var id in ids.Take(2))
        {
            var response = await h.Client.PostAsJsonAsync(
                "/api/sessions/" + id + "/move",
                new { parentSessionId = (string?)null, position = "first" }
            );
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }
        async Task<string[]> Roots(int limit)
        {
            var page = await h.Client.GetFromJsonAsync<JsonObject>(
                "/api/session-list/sidebar?limit=" + limit
            );
            return page!["sessions"]!
                .AsArray()
                .Select(row => row!["id"]!.GetValue<string>())
                .ToArray();
        }
        var previous = await Roots(100);
        var create = await h.Client.PostAsJsonAsync("/api/sessions", new { });
        Assert.Equal(HttpStatusCode.OK, create.StatusCode);
        var created = (await create.Content.ReadFromJsonAsync<JsonObject>())![
            "sessionId"
        ]!.GetValue<string>();
        Assert.Equal(created, (await Roots(50))[0]);
        Assert.Equal(new[] { created }.Concat(previous), await Roots(100));
        await h.Stop();
        h.Start();
        await h.Ready();
        Assert.Equal(created, (await Roots(50))[0]);
        Assert.Equal(new[] { created }.Concat(previous), await Roots(100));
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
    public async Task Actual_login_validates_without_cookie_writes_even_with_old_cookies_and_proxy_referrers()
    {
        await using var h = new Host();
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        await File.AppendAllTextAsync(h.ConfigPath, "url: https://declared.example/main/\n");
        h.Start();
        await h.Ready();
        h.Client.DefaultRequestHeaders.Authorization = null;
        h.Client.DefaultRequestHeaders.Add("Origin", "http://127.0.0.1:" + h.Port);
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await h.Client.GetAsync("/api/sessions")).StatusCode
        );
        h.Client.DefaultRequestHeaders.Add("Cookie", "foxwarm_token=old-http-only-cookie");
        foreach (
            var referrer in new[]
            {
                "https://proxy.example/nested/login.html",
                "http://127.0.0.1/",
                "https://foreign.invalid/login.html",
            }
        )
        {
            h.Client.DefaultRequestHeaders.Referrer = new Uri(referrer);
            var login = await h.Client.PostAsJsonAsync("/api/auth", new { token = h.Token });
            Assert.True(login.IsSuccessStatusCode);
            Assert.False(login.Headers.Contains("Set-Cookie"));
            var invalid = await h.Client.PostAsJsonAsync("/api/auth", new { token = "wrong" });
            Assert.Equal(HttpStatusCode.Unauthorized, invalid.StatusCode);
            Assert.False(invalid.Headers.Contains("Set-Cookie"));
        }
        h.Client.DefaultRequestHeaders.Remove("Origin");
        h.Client.DefaultRequestHeaders.Add("Origin", "https://foreign.invalid");
        h.Client.DefaultRequestHeaders.Remove("Cookie");
        h.Client.DefaultRequestHeaders.Add(
            "Cookie",
            "foxwarm_token=" + Uri.EscapeDataString(h.Token)
        );
        Assert.True((await h.Client.GetAsync("/api/sessions")).IsSuccessStatusCode);
        h.Client.DefaultRequestHeaders.Authorization = new("Bearer", h.Token);
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
    public async Task Actual_invalid_YAML_startup_inputs_fail_without_touching_existing_secret()
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
            await File.WriteAllTextAsync(h.ConfigPath, $"bot: {{httpPort: {h.Port}}}\nurl: '{address}'\n");
            h.Start();
            await h.Failed();
            Assert.Equal(h.Token, await File.ReadAllTextAsync(h.TokenPath));
        }
        foreach (var invalidPort in new[] { "0", "-1", "65536", "1.5", "invalid" })
        {
            await File.WriteAllTextAsync(h.ConfigPath, $"bot: {{httpPort: {invalidPort}}}\n");
            h.Start();
            await h.Failed();
            Assert.Equal(h.Token, await File.ReadAllTextAsync(h.TokenPath));
        }
        await File.WriteAllTextAsync(h.ConfigPath, "bot:\n  enableWebUI: invalid\n");
        h.Start();
        await h.Failed();
    }
}
