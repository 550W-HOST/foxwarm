using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text.Json.Nodes;
using Foxwarm.Code;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

// Code's file browser, editor and SCM reaching an executable-Provider Node through the
// persistent service channel, over the real administrator HTTP routes.
public sealed class ProviderCodeServicesTests
{
    internal sealed class Fixture : IAsyncDisposable
    {
        internal readonly TempDirectory Temp = new();
        internal SessionManager Manager = null!;
        internal HttpServer Server = null!;
        internal HttpClient Client = null!;
        internal Foxwarm.Terminal.TerminalRegistry Terminals = null!;
        internal string Data => Path.Combine(Temp.Path, "data");
        internal string Target => Path.Combine(Temp.Path, "target");
        internal string Work => Path.Combine(Target, "work");

        internal static async Task<Fixture> Create(string mode = "normal", string? cli = null)
        {
            var f = new Fixture();
            Directory.CreateDirectory(Path.Combine(f.Data, "state"));
            Directory.CreateDirectory(f.Work);
            Directory.CreateDirectory(Path.Combine(f.Temp.Path, "resources"));
            await File.WriteAllTextAsync(
                Path.Combine(f.Data, "state", "config.yaml"),
                new JsonObject
                {
                    ["vector"] = false,
                    ["nodeProviders"] = new JsonObject
                    {
                        ["fixture"] = ProviderServiceChannelTests.Configuration(
                            f.Target,
                            mode,
                            5,
                            cli
                        ),
                    },
                }.ToJsonString()
            );
            var config = new ModelConfiguration(
                HostPaths.ForDataRoot(
                    f.Data,
                    applicationRoot: AppContext.BaseDirectory,
                    resourceRoot: Path.Combine(f.Temp.Path, "resources")
                )
            );
            var options = new ResponsesClientOptions(
                new Uri("http://127.0.0.1:1"),
                "local",
                "fixture",
                "",
                "",
                1000
            );
            f.Manager = new(f.Data, f.Temp.Path, options, config.Models);
            await f.Manager.LoadAsync();
            var socket = new TcpListener(IPAddress.Loopback, 0);
            socket.Start();
            var port = ((IPEndPoint)socket.LocalEndpoint).Port;
            socket.Stop();
            f.Terminals = new(f.Data, CancellationToken.None);
            f.Server = new(
                [],
                port,
                "fixture-provider-token",
                null,
                f.Manager,
                f.Terminals,
                webUiEnabled: true
            );
            var runtime = new SessionRuntime(f.Manager);
            new Foxwarm.Channels.WebUi.WebUIChannel(
                f.Manager,
                runtime,
                new MessageRouter(runtime),
                f.Terminals,
                f.Server.Downloads
            ).Register(f.Server.App);
            await f.Server.App.StartAsync();
            f.Client = new HttpClient
            {
                BaseAddress = new Uri("http://127.0.0.1:" + port),
                Timeout = TimeSpan.FromSeconds(60),
            };
            f.Client.DefaultRequestHeaders.Authorization = new("Bearer", "fixture-provider-token");
            return f;
        }

        internal string Fs(string operation, string path, string node = "fixture/svc") =>
            "/api/vscode-web/fs/"
            + operation
            + "?path="
            + Uri.EscapeDataString(path)
            + "&nodeId="
            + Uri.EscapeDataString(node);

        internal string Git(string operation, string workspace, string extra = "") =>
            "/api/vscode-web/git/"
            + operation
            + "?workspace="
            + Uri.EscapeDataString(workspace)
            + "&nodeId="
            + Uri.EscapeDataString("fixture/svc")
            + extra;

        internal int Count(string key, string? value = null) =>
            File.Exists(Path.Combine(Target, "channel.jsonl"))
                ? File.ReadAllLines(Path.Combine(Target, "channel.jsonl"))
                    .Select(line => JsonNode.Parse(line)!.AsObject())
                    .Count(entry =>
                        entry.ContainsKey(key) && (value is null || entry[key]!.ToString() == value)
                    )
                : 0;

        internal async Task<JsonObject> Json(HttpResponseMessage response)
        {
            Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
            return JsonNode.Parse(await response.Content.ReadAsStringAsync())!.AsObject();
        }

        public async ValueTask DisposeAsync()
        {
            Client.Dispose();
            await Server.App.StopAsync();
            await Server.App.DisposeAsync();
            await Terminals.DisposeAsync();
            await Manager.DisposeAsync();
            Temp.Dispose();
        }
    }

    private static async Task Run(string directory, params string[] arguments)
    {
        var info = new ProcessStartInfo("git") { WorkingDirectory = directory };
        foreach (
            var argument in new[]
            {
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
            }.Concat(arguments)
        )
            info.ArgumentList.Add(argument);
        using var process = Process.Start(info)!;
        await process.WaitForExitAsync();
        Assert.Equal(0, process.ExitCode);
    }

    [Fact]
    public async Task Code_files_browse_edit_and_manage_a_Provider_workspace_through_one_channel()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        // The node list publishes the declared services for the picker and Code availability.
        var nodes = (await f.Json(await f.Client.GetAsync("/api/nodes")))["nodes"]!.AsArray();
        var summary = nodes.OfType<JsonObject>().Single(n => n["id"]!.ToString() == "fixture/svc");
        Assert.Equal(1, summary["services"]!["vscode-fs"]!.GetValue<int>());
        Assert.Empty(
            nodes.OfType<JsonObject>().Single(n => n["id"]!.ToString() == "fixture/plain")[
                "services"
            ]!.AsObject()
        );
        var file = Path.Combine(f.Work, "docs", "readme.md");
        Assert.Equal(
            HttpStatusCode.OK,
            (
                await f.Client.PostAsJsonAsync(
                    f.Fs("create-directory", Path.GetDirectoryName(file)!),
                    new { path = Path.GetDirectoryName(file), nodeId = "fixture/svc" }
                )
            ).StatusCode
        );
        using var write = new HttpRequestMessage(
            HttpMethod.Put,
            f.Fs("write-file", file) + "&create=1"
        )
        {
            Content = new ByteArrayContent("# title\n"u8.ToArray()),
        };
        Assert.Equal(HttpStatusCode.OK, (await f.Client.SendAsync(write)).StatusCode);
        Assert.Equal("# title\n", await File.ReadAllTextAsync(file));
        Assert.Equal("# title\n", await f.Client.GetStringAsync(f.Fs("read-file", file)));
        var listing = await f.Json(
            await f.Client.GetAsync(f.Fs("read-directory", Path.GetDirectoryName(file)!))
        );
        Assert.Equal("readme.md", listing["entries"]![0]!["name"]!.ToString());
        var stat = await f.Json(await f.Client.GetAsync(f.Fs("stat", file)));
        Assert.Equal(1, stat["type"]!.GetValue<int>());
        var rename = await f.Client.PostAsJsonAsync(
            "/api/vscode-web/fs/rename",
            new
            {
                nodeId = "fixture/svc",
                oldPath = file,
                newPath = file + ".bak",
                overwrite = false,
            }
        );
        Assert.Equal(HttpStatusCode.OK, rename.StatusCode);
        var gone = await f.Client.GetAsync(f.Fs("stat", file));
        Assert.Equal(HttpStatusCode.NotFound, gone.StatusCode);
        Assert.Equal(
            "FileNotFound",
            JsonNode.Parse(await gone.Content.ReadAsStringAsync())!["code"]!.ToString()
        );
        var delete = await f.Client.PostAsJsonAsync(
            "/api/vscode-web/fs/delete",
            new
            {
                nodeId = "fixture/svc",
                path = file + ".bak",
                recursive = false,
            }
        );
        Assert.Equal(HttpStatusCode.OK, delete.StatusCode);
        Assert.False(File.Exists(file + ".bak"));
        // Download route (the editor's binary read) uses the same channel.
        await File.WriteAllBytesAsync(Path.Combine(f.Work, "blob.bin"), [0, 1, 2, 255]);
        Assert.Equal(
            [0, 1, 2, 255],
            await f.Client.GetByteArrayAsync(f.Fs("read-file", Path.Combine(f.Work, "blob.bin")))
        );
        // Explorer bursts reuse one channel and do not launch per-call processes or rediscover.
        var lists = f.Count("oneShot", "list");
        await Task.WhenAll(
            Enumerable.Range(0, 40).Select(_ => f.Client.GetStringAsync(f.Fs("stat", f.Work)))
        );
        Assert.Equal(1, f.Count("connect"));
        Assert.Equal(lists, f.Count("oneShot", "list"));
        // Resident-style validation still applies at the HTTP edge.
        var invalid = await f.Client.GetAsync(f.Fs("stat", f.Work, "fixture/svc/extra"));
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        var plain = await f.Client.GetAsync(f.Fs("stat", f.Work, "fixture/plain"));
        Assert.Equal(HttpStatusCode.NotImplemented, plain.StatusCode);
        Assert.Equal(
            "UnsupportedService",
            JsonNode.Parse(await plain.Content.ReadAsStringAsync())!["code"]!.ToString()
        );
        var offline = await f.Client.GetAsync(f.Fs("stat", f.Work, "fixture/down"));
        Assert.Equal(HttpStatusCode.ServiceUnavailable, offline.StatusCode);
        using var anonymous = new HttpClient { BaseAddress = f.Client.BaseAddress };
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await anonymous.GetAsync(f.Fs("stat", f.Work))).StatusCode
        );
        Assert.Equal(1, f.Count("connect"));
    }

    [Fact]
    public async Task Code_source_control_reads_Git_status_and_content_from_the_Provider_node()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        await Run(f.Work, "init", "-q", "-b", "main");
        await File.WriteAllTextAsync(Path.Combine(f.Work, "tracked.txt"), "base\n");
        await Run(f.Work, "add", "tracked.txt");
        await Run(f.Work, "commit", "-q", "-m", "initial");
        await File.WriteAllTextAsync(Path.Combine(f.Work, "tracked.txt"), "edited\n");
        await File.WriteAllTextAsync(Path.Combine(f.Work, "fresh.txt"), "new\n");
        var status = await f.Json(await f.Client.GetAsync(f.Git("status", f.Work)));
        Assert.Equal("fixture/svc", status["nodeId"]!.ToString());
        var changes = status["changes"]!
            .AsArray()
            .OfType<JsonObject>()
            .ToDictionary(c => c["path"]!.ToString());
        Assert.Equal("modified", changes["tracked.txt"]["kind"]!.ToString());
        Assert.Equal("untracked", changes["fresh.txt"]["kind"]!.ToString());
        Assert.Equal(
            "base\n",
            await f.Client.GetStringAsync(f.Git("content", f.Work, "&path=tracked.txt&side=base"))
        );
        // The fixture serves vscode-git version 1, so immutable commit details are refused.
        var commit = await f.Client.GetAsync(f.Git("commit", f.Work, "&id=HEAD"));
        Assert.Equal(HttpStatusCode.NotImplemented, commit.StatusCode);
        Assert.Equal(1, f.Count("connect"));
    }

    [Fact]
    public async Task Qualified_Node_identity_round_trips_through_the_Code_URI_bootstrap_and_workspace_files()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        foreach (
            var asset in new[]
            {
                "out/nls.messages.js",
                "out/vs/workbench/workbench.web.main.internal.css",
                "out/vs/workbench/workbench.web.main.internal.js",
            }
        )
        {
            var path = Path.Combine(
                f.Temp.Path,
                "resources/packages/vscode-web/assets/vscode-web",
                asset
            );
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            await File.WriteAllTextAsync(path, "metadata fixture");
        }
        // The frontend encodes the whole qualified ID as the URI authority component.
        var folder = "foxwarm://node+" + Uri.EscapeDataString("fixture/svc") + f.Work;
        Assert.Contains("fixture%2Fsvc", folder);
        var html = await f.Client.GetStringAsync(
            "/vscode-web/?embedded=true&initialFolderUri=" + Uri.EscapeDataString(folder)
        );
        Assert.DoesNotContain("@@", html);
        var workspaceFile = Path.Combine(
            f.Data,
            "state/vscode-web/node-fixture%2Fsvc.code-workspace"
        );
        var workspace = JsonNode.Parse(await File.ReadAllTextAsync(workspaceFile))!;
        Assert.Equal(folder, workspace["folders"]![0]!["uri"]!.ToString());
        // The explicit nodeId and the URI-derived Node agree; a conflicting folder is rewritten to the Node root.
        var viaQuery = await f.Client.GetStringAsync(
            "/vscode-web/?nodeId=" + Uri.EscapeDataString("fixture/svc")
        );
        Assert.Contains("node-fixture%252Fsvc.code-workspace", viaQuery);
        var bad = await f.Client.GetAsync(
            "/vscode-web/?nodeId=" + Uri.EscapeDataString("fixture/svc/extra")
        );
        Assert.NotEqual(HttpStatusCode.OK, bad.StatusCode);
    }
}
