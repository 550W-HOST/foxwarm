using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Code;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class CodeRoutesTests
{
    private sealed class Fixture : IAsyncDisposable
    {
        internal readonly TempDirectory Temp = new();
        internal SessionManager Manager = null!;
        internal HttpServer Server = null!;
        internal HttpClient Client = null!;
        internal Foxwarm.Terminal.TerminalRegistry Terminals = null!;
        internal string Data => Path.Combine(Temp.Path, "data literal%20 space 雪");
        internal string Assets =>
            Path.Combine(Temp.Path, "resources/packages/vscode-web/assets/vscode-web");
        internal string Work => Path.Combine(Temp.Path, "work");

        internal static async Task<Fixture> Create()
        {
            var f = new Fixture();
            Directory.CreateDirectory(f.Data);
            Directory.CreateDirectory(f.Work);
            Directory.CreateDirectory(Path.Combine(f.Temp.Path, "resources"));
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
            f.Manager = new(f.Data, f.Work, options, config.Models);
            await f.Manager.LoadAsync();
            var socket = new TcpListener(IPAddress.Loopback, 0);
            socket.Start();
            var port = ((IPEndPoint)socket.LocalEndpoint).Port;
            socket.Stop();
            f.Terminals = new(f.Data, CancellationToken.None);
            f.Server = new([], port, "fixture-code-token", null, f.Manager, f.Terminals);
            await f.Server.App.StartAsync();
            f.Client = new HttpClient
            {
                BaseAddress = new Uri("http://127.0.0.1:" + port),
                Timeout = TimeSpan.FromSeconds(60),
            };
            f.Client.DefaultRequestHeaders.ExpectContinue = true;
            f.Client.DefaultRequestHeaders.Authorization = new("Bearer", "fixture-code-token");
            return f;
        }

        internal string Fs(string operation, string path) =>
            "/api/vscode-web/fs/" + operation + "?path=" + Uri.EscapeDataString(path);

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

    [Fact]
    public async Task Local_Code_native_metadata_and_link_errors_follow_the_filesystem_service_contract()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        var file = Path.Combine(f.Work, "readonly");
        await File.WriteAllTextAsync(file, "content");
        File.SetUnixFileMode(file, UnixFileMode.UserRead);
        var stat = await f.Json(await f.Client.GetAsync(f.Fs("stat", file)));
        Assert.Equal(1, stat["permissions"]!.GetValue<int>());
        var nested = await f.Client.GetAsync(f.Fs("stat", file + "/child"));
        Assert.Equal(HttpStatusCode.BadRequest, nested.StatusCode);
        Assert.Equal(
            "FileNotADirectory",
            JsonNode.Parse(await nested.Content.ReadAsStringAsync())!["code"]!.ToString()
        );
        File.CreateSymbolicLink(Path.Combine(f.Work, "broken"), Path.Combine(f.Work, "missing"));
        var listing = await f.Json(await f.Client.GetAsync(f.Fs("read-directory", f.Work)));
        Assert.Equal(
            0,
            listing["entries"]!.AsArray().Single(entry => entry!["name"]!.ToString() == "broken")![
                "type"
            ]!.GetValue<int>()
        );
        var directory = Path.Combine(f.Work, "directory");
        Directory.CreateDirectory(directory);
        var refused = await f.Client.PostAsJsonAsync(
            f.Fs("delete", directory),
            new { recursive = false }
        );
        Assert.Equal(HttpStatusCode.InternalServerError, refused.StatusCode);
        Assert.Equal(
            "Unknown",
            JsonNode.Parse(await refused.Content.ReadAsStringAsync())!["code"]!.ToString()
        );
        Assert.True(Directory.Exists(directory));
        var self = await f.Client.PostAsJsonAsync(
            "/api/vscode-web/fs/rename",
            new
            {
                oldPath = file,
                newPath = file,
                overwrite = true,
            }
        );
        Assert.Equal(HttpStatusCode.NotFound, self.StatusCode);
        Assert.False(File.Exists(file));
    }

    [Fact]
    public async Task Local_Git_validates_working_content_refs_before_dispatch_and_keeps_optional_Git()
    {
        await using var f = await Fixture.Create();
        var file = Path.Combine(f.Work, "working.txt");
        await File.WriteAllTextAsync(file, "working without a repository");
        var url =
            "/api/vscode-web/git/content?workspace="
            + Uri.EscapeDataString(f.Work)
            + "&path=working.txt&side=working&ref=not-an-immutable-ref";
        var rejected = await f.Client.GetAsync(url);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, rejected.StatusCode);
        Assert.Equal(
            "InvalidCommit",
            JsonNode.Parse(await rejected.Content.ReadAsStringAsync())!["code"]!.ToString()
        );
        var working = url.Replace("&ref=not-an-immutable-ref", "");
        foreach (var reference in new[] { "", "&ref=HEAD", "&ref=" + new string('a', 40) })
            Assert.Equal(
                "working without a repository",
                await f.Client.GetStringAsync(working + reference)
            );
        using var anonymous = new HttpClient { BaseAddress = f.Client.BaseAddress };
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync(working)).StatusCode);
        var invalidPath = await f.Client.GetAsync(
            url.Replace("path=working.txt", "path=../escape")
        );
        Assert.Equal(HttpStatusCode.BadRequest, invalidPath.StatusCode);
        Assert.Equal(
            "InvalidPath",
            JsonNode.Parse(await invalidPath.Content.ReadAsStringAsync())!["code"]!.ToString()
        );
        var invalidSide = await f.Client.GetAsync(url.Replace("side=working", "side=invalid"));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, invalidSide.StatusCode);
        Assert.Equal(
            "InvalidCommit",
            JsonNode.Parse(await invalidSide.Content.ReadAsStringAsync())!["code"]!.ToString()
        );
        await File.WriteAllTextAsync(Path.Combine(f.Work, "..literal"), "literal bytes");
        foreach (var side in new[] { "base", "working" })
        foreach (var reference in new[] { "HEAD", "not-an-immutable-ref" })
        {
            var literal = await f.Client.GetAsync(
                url.Replace("path=working.txt", "path=..literal")
                    .Replace("side=working", "side=" + side)
                    .Replace("ref=not-an-immutable-ref", "ref=" + reference)
            );
            Assert.Equal(HttpStatusCode.BadRequest, literal.StatusCode);
            Assert.Equal(
                "InvalidPath",
                JsonNode.Parse(await literal.Content.ReadAsStringAsync())!["code"]!.ToString()
            );
        }
        var previous = Environment.GetEnvironmentVariable("PATH");
        try
        {
            Environment.SetEnvironmentVariable("PATH", Path.Combine(f.Temp.Path, "no-git"));
            Assert.Equal("working without a repository", await f.Client.GetStringAsync(working));
            Assert.Equal(
                HttpStatusCode.UnprocessableEntity,
                (await f.Client.GetAsync(url)).StatusCode
            );
            var status = await f.Client.GetAsync(
                "/api/vscode-web/git/status?workspace=" + Uri.EscapeDataString(f.Work)
            );
            Assert.Equal(HttpStatusCode.ServiceUnavailable, status.StatusCode);
            Assert.Equal(
                "Unavailable",
                JsonNode.Parse(await status.Content.ReadAsStringAsync())!["code"]!.ToString()
            );
            var content = await f.Client.GetAsync(
                url.Replace("&side=working&ref=not-an-immutable-ref", "&side=base")
            );
            Assert.Equal(HttpStatusCode.ServiceUnavailable, content.StatusCode);
        }
        finally
        {
            Environment.SetEnvironmentVariable("PATH", previous);
        }
    }

    [Fact]
    public async Task Real_human_filesystem_binary_flags_links_rename_delete_and_precise_root_descriptors()
    {
        await using var f = await Fixture.Create();
        var roots = await f.Json(await f.Client.GetAsync("/api/vscode-web/fs/workspace-roots"));
        Assert.Equal(1, roots["version"]!.GetValue<int>());
        Assert.Equal(
            Path.GetFullPath(AppContext.BaseDirectory),
            roots["roots"]!["app"]!["path"]!.ToString()
        );
        Assert.Equal(f.Data, roots["roots"]!["data"]!["path"]!.ToString());
        Assert.Equal(
            Path.Combine(f.Data, "state", "config.yaml"),
            roots["configFiles"]!["app"]!["path"]!.ToString()
        );
        Assert.Equal(
            HttpStatusCode.Conflict,
            (await f.Client.PostAsJsonAsync(f.Fs("create-directory", "/"), new { })).StatusCode
        );
        var outside = Path.Combine(f.Temp.Path, "outside-model-work");
        await f.Json(await f.Client.PostAsJsonAsync(f.Fs("create-directory", outside), new { }));
        var file = Path.Combine(outside, "中文<& file.bin");
        var bytes = new byte[] { 0, 255, 17, 80, 75 };
        Assert.Equal(
            HttpStatusCode.NotFound,
            (
                await f.Client.PutAsync(f.Fs("write-file", file), new ByteArrayContent(bytes))
            ).StatusCode
        );
        var written = await f.Json(
            await f.Client.PutAsync(
                f.Fs("write-file", file) + "&create=1",
                new ByteArrayContent(bytes)
            )
        );
        Assert.Equal(1, written["stat"]!["type"]!.GetValue<int>());
        Assert.True(written["stat"]!["ctime"]!.GetValue<double>() > 0);
        Assert.Equal(bytes, await f.Client.GetByteArrayAsync(f.Fs("read-file", file)));
        Assert.Equal(
            HttpStatusCode.Conflict,
            (
                await f.Client.PutAsync(
                    f.Fs("write-file", file) + "&create=yes",
                    new ByteArrayContent(bytes)
                )
            ).StatusCode
        );
        await f.Json(
            await f.Client.PutAsync(
                f.Fs("write-file", file) + "&create=true&overwrite=true",
                new ByteArrayContent([9, 0])
            )
        );
        var link = Path.Combine(outside, "link.bin");
        File.CreateSymbolicLink(link, file);
        var stat = await f.Json(await f.Client.GetAsync(f.Fs("stat", link)));
        Assert.Equal(65, stat["type"]!.GetValue<int>());
        Assert.Equal(
            new byte[] { 9, 0 },
            await f.Client.GetByteArrayAsync(f.Fs("read-file", link))
        );
        var listing = await f.Json(await f.Client.GetAsync(f.Fs("read-directory", outside)));
        Assert.Equal(2, listing["entries"]!.AsArray().Count);
        var renamed = Path.Combine(outside, "new.bin");
        await f.Json(
            await f.Client.PostAsJsonAsync(
                "/api/vscode-web/fs/rename",
                new { oldPath = file, newPath = renamed }
            )
        );
        Assert.False(File.Exists(file));
        Assert.Equal(new byte[] { 9, 0 }, await File.ReadAllBytesAsync(renamed));
        await f.Json(
            await f.Client.PostAsJsonAsync(f.Fs("delete", renamed), new { recursive = false })
        );
        Assert.False(File.Exists(renamed));
        await f.Json(
            await f.Client.PostAsJsonAsync(f.Fs("delete", outside), new { recursive = true })
        );
        Assert.False(Directory.Exists(outside));
    }

    [Fact]
    public async Task Real_fifty_MiB_boundary_does_not_raise_other_request_limits_and_rejects_before_write()
    {
        await using var f = await Fixture.Create();
        var file = Path.Combine(f.Work, "large.bin");
        var bytes = new byte[CodeFileService.MaxFileBytes];
        bytes[0] = 255;
        bytes[^1] = 123;
        await f.Json(
            await f.Client.PutAsync(
                f.Fs("write-file", file) + "&create=1",
                new ByteArrayContent(bytes)
            )
        );
        var read = await f.Client.GetByteArrayAsync(f.Fs("read-file", file));
        Assert.Equal(bytes.Length, read.Length);
        Assert.Equal(255, read[0]);
        Assert.Equal(123, read[^1]);
        Assert.Equal(
            HttpStatusCode.RequestEntityTooLarge,
            (
                await f.Client.PutAsync(
                    f.Fs("write-file", file) + "&overwrite=1",
                    new ByteArrayContent(new byte[CodeFileService.MaxFileBytes + 1])
                )
            ).StatusCode
        );
        Assert.Equal(bytes.Length, new FileInfo(file).Length);
        await using (var output = File.OpenWrite(file))
            output.SetLength(CodeFileService.MaxFileBytes + 1);
        Assert.Equal(
            HttpStatusCode.RequestEntityTooLarge,
            (await f.Client.GetAsync(f.Fs("read-file", file))).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.RequestEntityTooLarge,
            (
                await f.Client.PostAsync(
                    "/api/auth",
                    new StringContent(
                        new string(' ', 3 * 1024 * 1024),
                        Encoding.UTF8,
                        "application/json"
                    )
                )
            ).StatusCode
        );
    }

    [Fact]
    public async Task Auth_origin_no_fake_remote_or_PTY_and_missing_asset_truth()
    {
        await using var f = await Fixture.Create();
        var file = Path.Combine(f.Work, "auth.bin");
        await File.WriteAllTextAsync(file, "untouched");
        using var anonymous = new HttpClient { BaseAddress = f.Client.BaseAddress };
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await anonymous.GetAsync(f.Fs("read-file", file))).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await anonymous.GetAsync("/vscode-web/static/out/nls.messages.js")).StatusCode
        );
        using var hostile = new HttpRequestMessage(
            HttpMethod.Put,
            f.Fs("write-file", file) + "&overwrite=1"
        )
        {
            Content = new ByteArrayContent([1]),
        };
        hostile.Headers.Add("Origin", "http://foreign.invalid");
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.SendAsync(hostile)).StatusCode);
        Assert.Equal("untouched", await File.ReadAllTextAsync(file));
        var remote = await f.Client.GetAsync(f.Fs("read-file", file) + "&nodeId=future");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, remote.StatusCode);
        Assert.Equal(
            "NodeUnavailable",
            JsonNode.Parse(await remote.Content.ReadAsStringAsync())!["code"]!.ToString()
        );
        var nodes = await f.Json(await f.Client.GetAsync("/api/nodes"));
        var services = nodes["nodes"]![0]!["services"]!.AsObject();
        Assert.Equal(1, services["vscode-fs"]!.GetValue<int>());
        Assert.Equal(2, services["vscode-git"]!.GetValue<int>());
        Assert.Equal(
            Foxwarm.Terminal.TerminalRegistry.IsSupported,
            services.ContainsKey("vscode-pty")
        );
        var missing = await f.Client.GetAsync("/vscode-web/");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, missing.StatusCode);
        Assert.Contains("no-store", missing.Headers.CacheControl!.ToString());
        Assert.Equal(
            HttpStatusCode.NotFound,
            (await f.Client.GetAsync("/vscode-web/static/missing.js")).StatusCode
        );
    }

    [Fact]
    public async Task Real_Git_root_rename_binary_immutable_content_and_direct_object_boundary()
    {
        await using var f = await Fixture.Create();
        var repo = f.Work;
        async Task<string> Git(params string[] args) =>
            Encoding.UTF8.GetString(
                await CodeGitService.RunAsync(repo, args, CancellationToken.None)
            );
        await Git("init", "-q");
        await Git("config", "user.name", "Fixture");
        await Git("config", "user.email", "fixture@example.invalid");
        await File.WriteAllTextAsync(Path.Combine(repo, "old.txt"), "original\n");
        await Git("add", ".");
        await Git("commit", "-qm", "root");
        var root = (await Git("rev-parse", "HEAD")).Trim();
        async Task<JsonObject> Commit(string id) =>
            await f.Json(
                await f.Client.GetAsync(
                    "/api/vscode-web/git/commit?workspace="
                        + Uri.EscapeDataString(repo)
                        + "&id="
                        + id
                )
            );
        var original = await Commit(root[..9]);
        Assert.Equal("empty-tree", original["comparison"]!["mode"]!.ToString());
        Assert.Equal(root, original["commit"]!["oid"]!.ToString());
        File.Move(Path.Combine(repo, "old.txt"), Path.Combine(repo, "new.txt"));
        await File.WriteAllBytesAsync(Path.Combine(repo, "binary.bin"), [0, 1, 255]);
        await Git("add", ".");
        await Git("commit", "-qm", "rename and binary");
        var latest = (await Git("rev-parse", "HEAD")).Trim();
        var details = await Commit(latest);
        Assert.Equal(root, details["comparison"]!["parentOid"]!.ToString());
        Assert.Contains(
            details["files"]!.AsArray(),
            row => row!["kind"]!.ToString() == "renamed" && row["oldPath"]!.ToString() == "old.txt"
        );
        Assert.Contains(details["files"]!.AsArray(), row => row!["binary"]!.GetValue<bool>());
        Assert.Equal(1, details["stats"]!["binaryFiles"]!.GetValue<int>());
        await File.WriteAllTextAsync(Path.Combine(repo, "new.txt"), "working\n");
        var content =
            "/api/vscode-web/git/content?workspace=" + Uri.EscapeDataString(repo) + "&path=new.txt";
        Assert.Equal("original\n", await f.Client.GetStringAsync(content + "&ref=" + latest));
        Assert.Equal("working\n", await f.Client.GetStringAsync(content + "&side=working"));
        await File.WriteAllTextAsync(Path.Combine(repo, "untracked.txt"), "new");
        var status = await f.Json(
            await f.Client.GetAsync(
                "/api/vscode-web/git/status?workspace=" + Uri.EscapeDataString(repo)
            )
        );
        Assert.Equal(repo, status["topLevel"]!.ToString());
        Assert.Contains(
            status["changes"]!.AsArray(),
            row => row!["kind"]!.ToString() == "untracked"
        );
        Assert.Contains(
            status["changes"]!.AsArray(),
            row => row!["kind"]!.ToString() == "modified"
        );
        await Git("tag", "-a", "annotated", "-m", "tag");
        var tag = (await Git("rev-parse", "annotated")).Trim();
        Assert.Equal(
            HttpStatusCode.UnprocessableEntity,
            (
                await f.Client.GetAsync(
                    "/api/vscode-web/git/commit?workspace="
                        + Uri.EscapeDataString(repo)
                        + "&id="
                        + tag
                )
            ).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.UnprocessableEntity,
            (await f.Client.GetAsync(content + "&ref=main")).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.BadRequest,
            (
                await f.Client.GetAsync(
                    "/api/vscode-web/git/content?workspace="
                        + Uri.EscapeDataString(repo)
                        + "&path=../outside"
                )
            ).StatusCode
        );
        Assert.Equal(latest, (await Git("rev-parse", "HEAD")).Trim());
        var child = Path.Combine(f.Temp.Path, "submodule-source");
        Directory.CreateDirectory(child);
        async Task<string> SubGit(string directory, params string[] args) =>
            Encoding
                .UTF8.GetString(
                    await CodeGitService.RunAsync(directory, args, CancellationToken.None)
                )
                .Trim();
        await SubGit(child, "init", "-q");
        await SubGit(child, "config", "user.name", "Fixture");
        await SubGit(child, "config", "user.email", "fixture@example.invalid");
        await File.WriteAllTextAsync(Path.Combine(child, "child.txt"), "first\n");
        await SubGit(child, "add", ".");
        await SubGit(child, "commit", "-qm", "child first");
        var childFirst = await SubGit(child, "rev-parse", "HEAD");
        await Git("-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "sub");
        await Git("add", ".");
        await Git("commit", "-qm", "submodule fixture");
        var sub = Path.Combine(repo, "sub");
        await SubGit(sub, "config", "user.name", "Fixture");
        await SubGit(sub, "config", "user.email", "fixture@example.invalid");
        await File.WriteAllTextAsync(Path.Combine(sub, "child.txt"), "second\n");
        await SubGit(sub, "add", ".");
        await SubGit(sub, "commit", "-qm", "child second");
        var childSecond = await SubGit(sub, "rev-parse", "HEAD");
        await File.AppendAllTextAsync(Path.Combine(sub, "child.txt"), "dirty\n");
        var subStatus = (
            await f.Json(
                await f.Client.GetAsync(
                    "/api/vscode-web/git/status?workspace=" + Uri.EscapeDataString(repo)
                )
            )
        )["changes"]!
            .AsArray()
            .Single(row => row!["path"]!.ToString() == "sub")!["submodule"]!;
        Assert.Equal(childFirst, subStatus["headOid"]!.ToString());
        Assert.Equal(childFirst, subStatus["indexOid"]!.ToString());
        Assert.Equal(childSecond, subStatus["worktreeOid"]!.ToString());
        Assert.True(subStatus["dirty"]!.GetValue<bool>());
        await Git("add", "sub");
        await Git("commit", "-qm", "submodule transition");
        var subDetails = await Commit((await Git("rev-parse", "HEAD")).Trim());
        Assert.Contains(
            subDetails["files"]!.AsArray(),
            row =>
                row!["submodule"]!.GetValue<bool>()
                && row["oldOid"]!.ToString() == childFirst
                && row["newOid"]!.ToString() == childSecond
        );
        var branch = (await Git("branch", "--show-current")).Trim();
        await Git("checkout", "-qb", "side");
        await File.WriteAllTextAsync(Path.Combine(repo, "side.txt"), "side\n");
        await Git("add", "side.txt");
        await Git("commit", "-qm", "side");
        await Git("checkout", "-q", branch);
        await File.WriteAllTextAsync(Path.Combine(repo, "main.txt"), "main\n");
        await Git("add", "main.txt");
        await Git("commit", "-qm", "main");
        var firstParent = (await Git("rev-parse", "HEAD")).Trim();
        await Git("merge", "--no-ff", "side", "-qm", "merge");
        var merged = await Commit((await Git("rev-parse", "HEAD")).Trim());
        Assert.Equal(2, merged["commit"]!["parents"]!.AsArray().Count);
        Assert.Equal(firstParent, merged["comparison"]!["parentOid"]!.ToString());
        Assert.Single(merged["files"]!.AsArray());
        Assert.Equal("side.txt", merged["files"]![0]!["path"]!.ToString());
        var large = Path.Combine(repo, "large.bin");
        using (var stream = File.Create(large))
            stream.SetLength(10 * 1024 * 1024 + 1);
        await Git("add", "large.bin");
        await Git("commit", "-qm", "large content");
        var bigContent =
            "/api/vscode-web/git/content?workspace="
            + Uri.EscapeDataString(repo)
            + "&path=large.bin";
        Assert.Equal(
            HttpStatusCode.RequestEntityTooLarge,
            (await f.Client.GetAsync(bigContent)).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.RequestEntityTooLarge,
            (await f.Client.GetAsync(bigContent + "&side=working")).StatusCode
        );
    }

    [Fact]
    public async Task Windows_Code_normalized_drive_root_reaches_filesystem_and_terminal()
    {
        if (!OperatingSystem.IsWindows())
            return;
        await using var f = await Fixture.Create();
        var root = Path.GetPathRoot(f.Work)!;
        var mapped = CodeFileService.PathValue(CodeNativePaths.Transport(root));
        Assert.Equal(root, CodeNativePaths.Native(mapped));
        Assert.Throws<CodeServiceException>(() => CodeNativePaths.Native(root[..2]));
        var stat = await f.Json(await f.Client.GetAsync(f.Fs("stat", mapped)));
        Assert.Equal(2, stat["type"]!.GetValue<int>());
        var listing = await f.Json(await f.Client.GetAsync(f.Fs("read-directory", mapped)));
        Assert.NotNull(listing["entries"]);
        var terminal = await f.Terminals.CreateAsync(mapped, 80, 24, CancellationToken.None);
        Assert.Equal(root, terminal.Cwd);
        await f.Terminals.CloseAsync(terminal.Id, "test-complete");
    }

    [Fact]
    public async Task Workspace_settings_and_malformed_file_retention_with_narrow_capability_scope()
    {
        await using var f = await Fixture.Create();
        var assets = f.Assets;
        foreach (
            var file in new[]
            {
                "out/nls.messages.js",
                "out/vs/workbench/workbench.web.main.internal.css",
                "out/vs/workbench/workbench.web.main.internal.js",
            }
        )
        {
            var path = Path.Combine(assets, file);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            await File.WriteAllTextAsync(path, "metadata fixture");
        }
        var workspace = Path.Combine(f.Data, "state/vscode-web/foxwarm.code-workspace");
        Directory.CreateDirectory(Path.GetDirectoryName(workspace)!);
        await File.WriteAllTextAsync(
            workspace,
            new JsonObject
            {
                ["folders"] = new JsonArray(
                    new JsonObject { ["uri"] = CodeWorkbench.FoxwarmUri(f.Work) }
                ),
                ["settings"] = new JsonObject
                {
                    ["yaml.schemaStore.enable"] = true,
                    ["editor.fontSize"] = 17,
                },
            }.ToJsonString()
        );
        var html = await f.Client.GetStringAsync("/vscode-web/?embedded=true");
        var match = System.Text.RegularExpressions.Regex.Match(html, "data-settings=\"([^\"]+)\"");
        var config = JsonNode.Parse(WebUtility.HtmlDecode(match.Groups[1].Value))!;
        Assert.Equal(
            CodeWorkbench.FoxwarmUri(workspace),
            "foxwarm://"
                + config["workspaceUri"]!["authority"]!.ToString()
                + config["workspaceUri"]!["path"]!.ToString()
        );
        var encodedFolder = "foxwarm://node+master/W%3A/work%20space/%E9%9B%AA";
        var folderHtml = await f.Client.GetStringAsync(
            "/vscode-web/?folderUri=" + Uri.EscapeDataString(encodedFolder)
        );
        var folderMatch = System.Text.RegularExpressions.Regex.Match(
            folderHtml,
            "data-settings=\"([^\"]+)\""
        );
        var folderConfig = JsonNode.Parse(WebUtility.HtmlDecode(folderMatch.Groups[1].Value))!;
        Assert.Equal(
            "/W%3A/work%20space/%E9%9B%AA",
            folderConfig["folderUri"]!["path"]!.GetValue<string>()
        );
        // The official FS reader decodes bootstrap path segments before HTTP dispatch.
        var workspaceTarget = Uri.UnescapeDataString(config["workspaceUri"]!["path"]!.ToString());
        Assert.Equal(
            await File.ReadAllTextAsync(workspace),
            await f.Client.GetStringAsync(f.Fs("read-file", workspaceTarget))
        );
        Assert.Contains("foxwarm-terminal", config["additionalBuiltinExtensions"]!.ToJsonString());
        Assert.DoesNotContain("@@", html);
        var retained = JsonNode.Parse(await File.ReadAllTextAsync(workspace))!;
        Assert.True(retained["settings"]!["yaml.schemaStore.enable"]!.GetValue<bool>());
        Assert.Equal(17, retained["settings"]!["editor.fontSize"]!.GetValue<int>());
        Assert.False(retained["settings"]!["redhat.telemetry.enabled"]!.GetValue<bool>());
        using var anonymous = new HttpClient { BaseAddress = f.Client.BaseAddress };
        var capability =
            config["productConfiguration"]!["webviewContentExternalBaseUrlTemplate"]!
                .ToString()
                .Replace("{{uuid}}", "instance") + "missing.js";
        Assert.Equal(HttpStatusCode.NotFound, (await anonymous.GetAsync(capability)).StatusCode);
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await anonymous.GetAsync("/vscode-web/extensions/foxwarm-fs/package.json")).StatusCode
        );
        await File.WriteAllTextAsync(workspace, "{broken workspace");
        await f.Client.GetStringAsync("/vscode-web/?embedded=true");
        Assert.Equal("{broken workspace", await File.ReadAllTextAsync(workspace));
    }

    [Fact]
    public async Task Project_workspaces_keep_independent_descriptors_and_reject_rebinding()
    {
        await using var f = await Fixture.Create();
        foreach (
            var file in new[]
            {
                "out/nls.messages.js",
                "out/vs/workbench/workbench.web.main.internal.css",
                "out/vs/workbench/workbench.web.main.internal.js",
            }
        )
        {
            var target = Path.Combine(f.Assets, file);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            await File.WriteAllTextAsync(target, "bootstrap fixture");
        }
        const string folder = "foxwarm://node+project-peer/srv/project";
        string Url(string id, string root = folder) =>
            "/vscode-web/?embedded=true&workspaceId="
            + Uri.EscapeDataString(id)
            + "&initialFolderUri="
            + Uri.EscapeDataString(root);
        foreach (var id in new[] { "work-one", "work-two" })
        {
            var html = await f.Client.GetStringAsync(Url(id));
            Assert.Contains("project-workspaces/" + id + ".code-workspace", html);
            var target = Path.Combine(
                f.Data,
                "state/vscode-web/project-workspaces",
                id + ".code-workspace"
            );
            var workspace = JsonNode.Parse(await File.ReadAllTextAsync(target))!;
            Assert.Equal(folder, workspace["folders"]![0]!["uri"]!.ToString());
            workspace["settings"]!["editor.fontSize"] = id == "work-one" ? 15 : 19;
            await File.WriteAllTextAsync(target, workspace.ToJsonString());
            await f.Client.GetStringAsync(Url(id));
            Assert.Equal(
                id == "work-one" ? 15 : 19,
                JsonNode.Parse(await File.ReadAllTextAsync(target))!["settings"]![
                    "editor.fontSize"
                ]!.GetValue<int>()
            );
        }
        Assert.False(File.Exists(Path.Combine(f.Data, "state/vscode-web/foxwarm.code-workspace")));
        Assert.Equal(
            HttpStatusCode.BadRequest,
            (await f.Client.GetAsync(Url("work-one", "foxwarm://node+master/other"))).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.BadRequest,
            (await f.Client.GetAsync(Url("../escape"))).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.BadRequest,
            (await f.Client.GetAsync("/vscode-web/?workspaceId=work-one")).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.BadRequest,
            (await f.Client.GetAsync("/vscode-web/?embedded=true&workspaceId=work-one")).StatusCode
        );
    }

    [Theory]
    [InlineData("hvt", "r2o", "e", "ao", "sha-256", true)]
    [InlineData("$origin9", "encode_2", "$items", "browser_7", "sha-256", true)]
    [InlineData("changed", "encode", "items", "browser", "SHA-512", false)]
    public async Task Served_workbench_matches_helper_shapes_not_generated_names(
        string helper,
        string encoder,
        string items,
        string browser,
        string algorithm,
        bool supported
    )
    {
        await using var f = await Fixture.Create();
        var assets = f.Assets;
        var main = Path.Combine(assets, "out/vs/workbench/workbench.web.main.internal.js");
        Directory.CreateDirectory(Path.GetDirectoryName(main)!);
        await File.WriteAllTextAsync(Path.Combine(assets, "out/nls.messages.js"), "// fixture");
        await File.WriteAllTextAsync(Path.ChangeExtension(main, "css"), "/* fixture */");
        var original =
            "async function "
            + helper
            + "(a,o){if(!crypto.subtle)throw new Error(\"'crypto.subtle' is not available so webviews will not work.\");"
            + "let bytes=new TextEncoder().encode(JSON.stringify({parentOrigin:a,salt:o})),hash=await crypto.subtle.digest(\""
            + algorithm
            + "\",bytes);return "
            + encoder
            + "(hash)}function "
            + encoder
            + "(value){return value}";
        var probe =
            "async hasResources(){try{let "
            + items
            + "=await "
            + browser
            + "().navigator.clipboard.read();";
        const string unrelated = "const other=()=>crypto.subtle.digest(\"sha-256\",otherBytes);";
        await File.WriteAllTextAsync(
            main,
            unrelated + original + "class Clipboard{" + probe + "return true}catch{}return false}}"
        );
        var result = await f.Client.GetAsync(
            "/vscode-web/static/out/vs/workbench/workbench.web.main.internal.js"
        );
        if (!supported)
        {
            Assert.Equal(HttpStatusCode.ServiceUnavailable, result.StatusCode);
            return;
        }
        Assert.Equal(HttpStatusCode.OK, result.StatusCode);
        Assert.Contains("no-store", result.Headers.CacheControl!.ToString());
        var served = await result.Content.ReadAsStringAsync();
        Assert.StartsWith(unrelated, served);
        Assert.Contains("async function " + helper + "(a,o){let bytes=", served);
        Assert.Contains("globalThis.__foxwarmSha256Digest(\"sha-256\",bytes)", served);
        Assert.Contains(
            "if(/Firefox\\//.test(navigator.userAgent))return this.resources.length>0;try{let "
                + items
                + "=await "
                + browser,
            served
        );
        Assert.Equal(
            unrelated + original + "class Clipboard{" + probe + "return true}catch{}return false}}",
            await File.ReadAllTextAsync(main)
        );
        using var anonymous = new HttpClient { BaseAddress = f.Client.BaseAddress };
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (
                await anonymous.GetAsync(
                    "/vscode-web/static/out/vs/workbench/workbench.web.main.internal.js"
                )
            ).StatusCode
        );
        // Neither an arbitrary async function nor a changed clipboard body is patched.
        foreach (
            var changed in new[]
            {
                original.Replace("if(!crypto.subtle)", "if(!globalThis.crypto)")
                    + "class Clipboard{"
                    + probe
                    + "}}",
                original
                    + "class Clipboard{"
                    + probe.Replace("clipboard.read()", "clipboard.readText()")
                    + "}}",
            }
        )
        {
            await File.WriteAllTextAsync(main, changed);
            Assert.Equal(
                HttpStatusCode.ServiceUnavailable,
                (
                    await f.Client.GetAsync(
                        "/vscode-web/static/out/vs/workbench/workbench.web.main.internal.js"
                    )
                ).StatusCode
            );
        }
    }
}
