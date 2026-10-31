using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Channels.WebUi;
using Foxwarm.Code;
using Foxwarm.Models;
using Foxwarm.Projects;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

public sealed class ProjectWorkspaceTests
{
    private sealed class Fixture : IAsyncDisposable
    {
        internal readonly TempDirectory Temp = new();
        internal SessionManager Manager = null!;
        internal HttpServer Server = null!;
        internal HttpClient Client = null!;
        internal Foxwarm.Terminal.TerminalRegistry Terminals = null!;
        internal ModelConfiguration Configuration = null!;
        internal string Data => Path.Combine(Temp.Path, "data");
        internal string Work => Path.Combine(Temp.Path, "work space");

        internal static async Task<Fixture> Create()
        {
            var f = new Fixture();
            Directory.CreateDirectory(f.Work);
            f.Configuration = new(f.Data);
            var options = new ResponsesClientOptions(
                new Uri("http://127.0.0.1:1"),
                "local",
                "fixture",
                "",
                "",
                713
            );
            f.Manager = new(f.Data, f.Work, options, f.Configuration.Models);
            await f.Manager.LoadAsync();
            var socket = new TcpListener(IPAddress.Loopback, 0);
            socket.Start();
            var port = ((IPEndPoint)socket.LocalEndpoint).Port;
            socket.Stop();
            f.Terminals = new(f.Data, CancellationToken.None);
            f.Server = new([], port, "synthetic-project-admin", null, f.Manager, f.Terminals);
            var runtime = new SessionRuntime(f.Manager);
            new WebUIChannel(
                f.Manager,
                runtime,
                new MessageRouter(runtime),
                f.Terminals,
                f.Server.Downloads
            ).Register(f.Server.App);
            await f.Server.App.StartAsync();
            f.Client = new() { BaseAddress = new("http://127.0.0.1:" + port) };
            f.Client.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-project-admin");
            return f;
        }

        internal async Task<JsonObject> Call(string method, string route, object? body = null)
        {
            using var request = new HttpRequestMessage(new HttpMethod(method), route);
            if (body is not null)
                request.Content = JsonContent.Create(body);
            using var response = await Client.SendAsync(request);
            var text = await response.Content.ReadAsStringAsync();
            Assert.True(
                response.IsSuccessStatusCode,
                $"{method} {route}: {(int)response.StatusCode} {text}"
            );
            return JsonNode.Parse(text)!.AsObject();
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
    public async Task Http_membership_initial_placement_retries_and_archive_preserve_conversation_authority()
    {
        await using var f = await Fixture.Create();
        using var anonymous = new HttpClient { BaseAddress = f.Client.BaseAddress };
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await anonymous.GetAsync("/api/projects")).StatusCode
        );
        var identity = ConfigurationYaml.Parse(
            "access: {identities: {viewer: {token: synthetic-project-viewer, surfaces: {webui: {sessions: [main]}}}}}",
            "fixture"
        );
        await f.Configuration.Access.ApplyAsync(AccessConfiguration.Normalize(identity["access"]));
        anonymous.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-project-viewer");
        Assert.Equal(
            HttpStatusCode.Forbidden,
            (await anonymous.GetAsync("/api/projects")).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.Forbidden,
            (
                await anonymous.PostAsJsonAsync(
                    "/api/projects",
                    new { nodeId = "master", rootPath = CodeNativePaths.Transport(f.Work) }
                )
            ).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.BadRequest,
            (
                await f.Client.PostAsJsonAsync(
                    "/api/projects",
                    new { nodeId = "master", rootPath = "relative" }
                )
            ).StatusCode
        );
        var resolved = await f.Call(
            "POST",
            "/api/projects/resolve-directory",
            new { nodeId = "master" }
        );
        Assert.Equal(
            CodeNativePaths.Transport(f.Manager.AgentDirectory("main")),
            resolved["rootPath"]!.ToString()
        );
        var project = (
            await f.Call(
                "POST",
                "/api/projects",
                new
                {
                    nodeId = "master",
                    rootPath = CodeNativePaths.Transport(f.Work) + "/../work space/.",
                    name = "Work",
                }
            )
        )["project"]!;
        var projectId = project["id"]!.ToString();
        var duplicate = (
            await f.Call(
                "POST",
                "/api/projects",
                new { nodeId = "master", rootPath = CodeNativePaths.Transport(f.Work) }
            )
        )["project"]!;
        Assert.Equal(projectId, duplicate["id"]!.ToString());
        var work = (
            await f.Call("POST", $"/api/projects/{projectId}/sessions", new { title = "Build" })
        )["session"]!;
        var workId = work["id"]!.ToString();
        var route = $"/api/project-sessions/{workId}/tabs";
        f.Manager.BeforeCreationPublication = async id =>
        {
            var first = JsonNode.Parse(
                await File.ReadAllTextAsync(Path.Combine(f.Data, "state/sessions", id + ".json"))
            )!;
            Assert.Equal("master", first["currentNode"]!.ToString());
            Assert.Equal(f.Work, first["cwd"]!.ToString());
        };
        var responses = await Task.WhenAll(
            Enumerable
                .Range(0, 3)
                .Select(_ =>
                    f.Call("POST", route, new { type = "agent", requestId = "same-agent" })
                )
        );
        var tab = responses[0]["tab"]!;
        Assert.All(
            responses,
            response => Assert.Equal(tab["id"]!.ToString(), response["tab"]!["id"]!.ToString())
        );
        var resource = tab["resourceId"]!.ToString();
        var saved = JsonNode.Parse(
            await File.ReadAllTextAsync(Path.Combine(f.Data, "state/sessions", resource + ".json"))
        )!;
        Assert.Equal("master", saved["currentNode"]!.ToString());
        Assert.Equal(f.Work, saved["cwd"]!.ToString());
        Assert.Empty(saved["history"]!.AsArray());
        var other = (
            await f.Call("POST", $"/api/projects/{projectId}/sessions", new { title = "Review" })
        )["session"]!;
        var otherRoute = $"/api/project-sessions/{other["id"]}/tabs";
        Assert.Equal(
            HttpStatusCode.Conflict,
            (
                await f.Client.PostAsJsonAsync(
                    otherRoute,
                    new
                    {
                        type = "agent",
                        existingSessionId = resource,
                        requestId = "linked-twice",
                    }
                )
            ).StatusCode
        );
        var rows = (await f.Call("GET", "/api/projects"))["projects"]![0]!["sessions"]!.AsArray();
        Assert.Empty(
            rows.Single(row => row!["id"]!.ToString() == other["id"]!.ToString())![
                "tabs"
            ]!.AsArray()
        );
        var moved = f.Work + " moved";
        Directory.Move(f.Work, moved);
        Assert.False(
            (
                await f.Client.PostAsJsonAsync(route, new { type = "agent", requestId = "recover" })
            ).IsSuccessStatusCode
        );
        var pending = (await f.Call("GET", "/api/projects"))["projects"]![0]!["sessions"]!
            .AsArray()
            .Single(row => row!["id"]!.ToString() == workId)!["tabs"]!
            .AsArray()
            .Single(row => row!["requestId"]?.ToString() == "recover")!;
        Assert.Equal("pending", pending["state"]!.ToString());
        Assert.Null(await f.Manager.GetExistingAsync(pending["resourceId"]!.ToString()));
        Directory.Move(moved, f.Work);
        var recovered = (
            await f.Call("POST", route, new { type = "agent", requestId = "recover" })
        )["tab"]!;
        Assert.Equal(pending["id"]!.ToString(), recovered["id"]!.ToString());
        Assert.Equal("ready", recovered["state"]!.ToString());
        await f.Call("DELETE", $"/api/project-tabs/{tab["id"]}");
        Assert.NotNull(await f.Manager.GetExistingAsync(resource));
        var linked = (
            await f.Call("POST", otherRoute, new { type = "agent", existingSessionId = resource })
        )["tab"]!;
        Assert.Equal(resource, linked["resourceId"]!.ToString());
        await f.Call("PATCH", $"/api/projects/{projectId}", new { archived = true });
        Assert.Equal(
            HttpStatusCode.NotFound,
            (await f.Client.PostAsJsonAsync(route, new { type = "terminal" })).StatusCode
        );
        Assert.NotNull(await f.Manager.GetExistingAsync(resource));
        Assert.Equal(
            projectId,
            (
                await f.Call(
                    "POST",
                    "/api/projects",
                    new { nodeId = "master", rootPath = CodeNativePaths.Transport(f.Work) }
                )
            )["project"]!["id"]!.ToString()
        );
    }

    [Fact]
    public async Task Native_Node_default_probe_and_directory_services_work_without_a_Session()
    {
        await using var f = await Fixture.Create();
        using var socket = new ClientWebSocket();
        var credential = f.Manager.Nodes.Registry.Create("project-peer");
        var address =
            f.Client.BaseAddress!.ToString().Replace("http", "ws")
            + "node_ws?id=project-peer&auth="
            + credential["authToken"];
        await socket.ConnectAsync(new Uri(address), default);
        async Task Send(JsonObject value) =>
            await socket.SendAsync(
                Encoding.UTF8.GetBytes(value.ToJsonString()),
                WebSocketMessageType.Text,
                true,
                default
            );
        async Task<JsonObject> Read()
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            using var stream = new MemoryStream();
            var buffer = new byte[65536];
            WebSocketReceiveResult part;
            do
            {
                part = await socket.ReceiveAsync(buffer, deadline.Token);
                stream.Write(buffer, 0, part.Count);
            } while (!part.EndOfMessage);
            return JsonNode.Parse(stream.ToArray())!.AsObject();
        }
        await Send(
            new()
            {
                ["type"] = "node_register",
                ["nodeType"] = "cli-node",
                ["nodeProtocol"] = new JsonObject { ["min"] = 1, ["max"] = 3 },
                ["capabilities"] = new JsonObject
                {
                    ["tools"] = new JsonArray(
                        new JsonObject { ["name"] = "get_default_cwd", ["description"] = "cwd" }
                    ),
                    ["services"] = new JsonObject { ["vscode-fs"] = 1 },
                },
            }
        );
        Assert.Equal("registered", (await Read())["type"]!.ToString());
        var creating = f.Call("POST", "/api/projects", new { nodeId = "project-peer" });
        var probe = await Read();
        Assert.Equal("get_default_cwd", probe["tool"]!.ToString());
        Assert.Null(probe["sessionCwd"]);
        await Send(
            new()
            {
                ["type"] = "tool_call_response",
                ["callId"] = probe["callId"]!.DeepClone(),
                ["result"] = new JsonObject { ["output"] = "/srv/project" },
            }
        );
        for (var i = 0; i < 2; i++)
        {
            var request = await Read();
            Assert.Equal("vscode-fs", request["service"]!.ToString());
            Assert.Equal("/srv/project", request["args"]!["path"]!.ToString());
            await Send(
                new()
                {
                    ["type"] = "node_service_response",
                    ["requestId"] = request["requestId"]!.DeepClone(),
                    ["result"] =
                        i == 0
                            ? new JsonObject { ["type"] = 2 }
                            : new JsonObject { ["entries"] = new JsonArray() },
                }
            );
        }
        var project = (await creating)["project"]!;
        Assert.Equal("/srv/project", project["rootPath"]!.ToString());
        var work = (
            await f.Call(
                "POST",
                $"/api/projects/{project["id"]}/sessions",
                new { title = "Remote" }
            )
        )["session"]!;
        var creatingAgent = f.Call(
            "POST",
            $"/api/project-sessions/{work["id"]}/tabs",
            new { type = "agent", requestId = "remote-agent" }
        );
        for (var i = 0; i < 2; i++)
        {
            var request = await Read();
            await Send(
                new()
                {
                    ["type"] = "node_service_response",
                    ["requestId"] = request["requestId"]!.DeepClone(),
                    ["result"] =
                        i == 0
                            ? new JsonObject { ["type"] = 2 }
                            : new JsonObject { ["entries"] = new JsonArray() },
                }
            );
        }
        var tab = (await creatingAgent)["tab"]!;
        var owner = (await f.Manager.GetExistingAsync(tab["resourceId"]!.ToString()))!;
        Assert.Equal(("project-peer", "/srv/project"), f.Manager.ExecutionPlacement(owner));
        socket.Abort();
    }

    [Fact]
    public void Store_reads_the_Source_schema_and_retains_membership_on_reopen()
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, "projects.sqlite");
        using (var source = new SqliteConnection("Data Source=" + path + ";Pooling=False"))
        {
            source.Open();
            using var command = source.CreateCommand();
            command.CommandText = """
                CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,node_id TEXT NOT NULL,root_path TEXT NOT NULL,created_at INTEGER NOT NULL,archived INTEGER NOT NULL DEFAULT 0,UNIQUE(node_id,root_path));
                INSERT INTO projects VALUES('source-project','Source','master','/srv/source',1,0);
                CREATE TABLE work_sessions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,created_at INTEGER NOT NULL,archived INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE work_tabs(id TEXT PRIMARY KEY,work_session_id TEXT NOT NULL REFERENCES work_sessions(id),type TEXT NOT NULL,title TEXT NOT NULL,resource_id TEXT,request_id TEXT UNIQUE,created_at INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'ready');
                INSERT INTO work_sessions VALUES('source-work','source-project','Existing work',2,0);
                INSERT INTO work_tabs VALUES('source-tab','source-work','agent','Original Agent','existing-source','original-request',3,'ready');
                PRAGMA user_version=1;
                """;
            command.ExecuteNonQuery();
        }
        string id;
        using (var store = new ProjectStore(path))
        {
            var existing = store.GetSession("source-work")!;
            Assert.Equal("existing-source", existing["tabs"]![0]!["resourceId"]!.ToString());
            var retry = store.CreateTab(
                "source-work",
                "agent",
                "Retry",
                "original-request",
                "main"
            );
            Assert.Equal("source-tab", ProjectStore.Text(retry, "id"));
            Assert.Equal("ready", ProjectStore.Text(retry, "state"));
            var session = store.CreateSession("source-project", "Retained");
            id = ProjectStore.Text(session, "id")!;
            var tab = store.CreateTab(id, "agent", "Agent", "source-retry", "main");
            store.UpdateTab(ProjectStore.Text(tab, "id")!, resourceId: "existing", state: "ready");
        }
        using var reopened = new ProjectStore(path);
        Assert.Equal("existing", reopened.GetSession(id)!["tabs"]![0]!["resourceId"]!.ToString());
        Assert.Equal("source-project", reopened.List(100, 0)[0]!["id"]!.ToString());
        Assert.Equal("existing-source", reopened.GetTab("source-tab")!["resourceId"]!.ToString());
        Assert.Equal("source-tab", reopened.FindRequest("original-request")!["id"]!.ToString());
        Assert.Single(reopened.GetSession("source-work")!["tabs"]!.AsArray());
    }
}
