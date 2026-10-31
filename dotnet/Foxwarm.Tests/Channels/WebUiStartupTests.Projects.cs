using System.Net;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Code;
using Foxwarm.Nodes;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

public sealed partial class WebUiStartupTests
{
    [Fact]
    public async Task Projects_resolve_the_remote_default_and_commit_the_remote_Agent_target()
    {
        await using var h = new Host();
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        var credential = new ApprovedNodeRegistry(h.Data).Create("project-worker");
        h.Start();
        await h.Ready();
        using var socket = new ClientWebSocket();
        await socket.ConnectAsync(
            new Uri(
                $"ws://127.0.0.1:{h.Port}/node_ws?id=project-worker&auth={credential["authToken"]}"
            ),
            default
        );
        async Task Send(JsonObject message) =>
            await socket.SendAsync(
                Encoding.UTF8.GetBytes(message.ToJsonString()),
                WebSocketMessageType.Text,
                true,
                default
            );
        async Task<JsonObject> Read()
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            using var stream = new MemoryStream();
            var buffer = new byte[65536];
            WebSocketReceiveResult frame;
            do
            {
                frame = await socket.ReceiveAsync(buffer, timeout.Token);
                stream.Write(buffer, 0, frame.Count);
            } while (!frame.EndOfMessage);
            return JsonNode.Parse(stream.ToArray())!.AsObject();
        }
        await Send(
            new()
            {
                ["type"] = "node_register",
                ["nodeType"] = "service-protocol-peer",
                ["nodeProtocol"] = new JsonObject { ["min"] = 1, ["max"] = 3 },
                ["capabilities"] = new JsonObject
                {
                    ["tools"] = new JsonArray(
                        new JsonObject
                        {
                            ["name"] = "get_default_cwd",
                            ["description"] = "Default directory",
                            ["parameters"] = new JsonObject { ["type"] = "object" },
                        }
                    ),
                    ["services"] = new JsonObject { ["vscode-fs"] = 1 },
                },
            }
        );
        Assert.Equal("registered", (await Read())["type"]!.ToString());
        const string root = "/srv/project space 雪";
        async Task<JsonObject> Complete(
            Task<HttpResponseMessage> pending,
            bool defaultDirectory = false
        )
        {
            if (defaultDirectory)
            {
                var probe = await Read();
                Assert.Equal("tool_call", probe["type"]!.ToString());
                Assert.Equal("get_default_cwd", probe["tool"]!.ToString());
                Assert.Null(probe["sessionCwd"]);
                await Send(
                    new()
                    {
                        ["type"] = "tool_call_response",
                        ["callId"] = probe["callId"]!.DeepClone(),
                        ["result"] = new JsonObject { ["output"] = root },
                    }
                );
            }
            foreach (var operation in new[] { "stat", "read-directory" })
            {
                var request = await Read();
                Assert.Equal("node_service_request", request["type"]!.ToString());
                Assert.Equal("vscode-fs", request["service"]!.ToString());
                Assert.Equal(operation, request["operation"]!.ToString());
                Assert.Equal(root, request["args"]!["path"]!.ToString());
                await Send(
                    new()
                    {
                        ["type"] = "node_service_response",
                        ["requestId"] = request["requestId"]!.DeepClone(),
                        ["result"] =
                            operation == "stat"
                                ? new JsonObject { ["type"] = 2 }
                                : new JsonObject { ["entries"] = new JsonArray() },
                    }
                );
            }
            using var response = await pending;
            var text = await response.Content.ReadAsStringAsync();
            Assert.True(response.IsSuccessStatusCode, text);
            return JsonNode.Parse(text)!.AsObject();
        }
        var resolved = await Complete(
            h.Client.PostAsJsonAsync(
                "/api/projects/resolve-directory",
                new { nodeId = "project-worker" }
            ),
            true
        );
        Assert.Equal(root, resolved["rootPath"]!.ToString());
        var project = (
            await Complete(
                h.Client.PostAsJsonAsync(
                    "/api/projects",
                    new { nodeId = "project-worker", rootPath = root }
                )
            )
        )["project"]!;
        using var workResponse = await h.Client.PostAsJsonAsync(
            $"/api/projects/{project["id"]}/sessions",
            new { }
        );
        workResponse.EnsureSuccessStatusCode();
        var work = (await workResponse.Content.ReadFromJsonAsync<JsonObject>())!["session"]!;
        var tab = (
            await Complete(
                h.Client.PostAsJsonAsync(
                    $"/api/project-sessions/{work["id"]}/tabs",
                    new { type = "agent", requestId = "remote-agent" }
                )
            )
        )["tab"]!;
        var authority = JsonNode.Parse(
            await File.ReadAllTextAsync(
                Path.Combine(h.Data, "state", "sessions", tab["resourceId"] + ".json")
            )
        )!;
        Assert.Equal("project-worker", authority["currentNode"]!.ToString());
        Assert.Equal(root, authority["cwd"]!.ToString());
        socket.Abort();
        await h.Stop();
    }

    [Fact]
    public async Task Projects_keep_targets_idempotency_association_and_pending_creation_across_restart()
    {
        await using var h = new Host();
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        await File.WriteAllTextAsync(
            h.ConfigPath,
            $"bot: {{httpPort: {h.Port}}}\nvector: false\naccess:\n  identities:\n    viewer:\n      token: synthetic-project-viewer\n      surfaces:\n        webui: {{sessions: [main]}}\n"
        );
        var directory = Path.Combine(h.Temp.Path, "project space 雪");
        Directory.CreateDirectory(directory);
        var root = CodeNativePaths.Transport(directory);
        h.Start();
        await h.Ready();

        async Task<JsonObject> Call(
            string method,
            string route,
            object? body = null,
            HttpStatusCode expected = HttpStatusCode.OK
        )
        {
            using var request = new HttpRequestMessage(new HttpMethod(method), route);
            if (body is not null)
                request.Content = JsonContent.Create(body);
            using var response = await h.Client.SendAsync(request);
            var text = await response.Content.ReadAsStringAsync();
            Assert.True(
                response.StatusCode == expected,
                $"{method} {route}: {(int)response.StatusCode}: {text}"
            );
            return JsonNode.Parse(text)!.AsObject();
        }
        static string Id(JsonNode node) => node["id"]!.GetValue<string>();
        async Task<string> Work(string project) =>
            Id(
                (await Call("POST", $"/api/projects/{project}/sessions", new { title = "Build" }))[
                    "session"
                ]!
            );

        using (var denied = new HttpClient { BaseAddress = h.Client.BaseAddress })
        {
            Assert.Equal(
                HttpStatusCode.Unauthorized,
                (await denied.GetAsync("/api/projects")).StatusCode
            );
            denied.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-project-viewer");
            Assert.Equal(
                HttpStatusCode.Forbidden,
                (await denied.GetAsync("/api/projects")).StatusCode
            );
            Assert.Equal(
                HttpStatusCode.Forbidden,
                (
                    await denied.PostAsJsonAsync(
                        "/api/projects",
                        new { nodeId = "master", rootPath = root }
                    )
                ).StatusCode
            );
        }
        await Call(
            "POST",
            "/api/projects",
            new { nodeId = "master", rootPath = "relative" },
            HttpStatusCode.BadRequest
        );
        await Call(
            "POST",
            "/api/projects",
            new { nodeId = "master", rootPath = root + "/missing" },
            HttpStatusCode.NotFound
        );
        await Call(
            "POST",
            "/api/projects",
            new { nodeId = "offline", rootPath = root },
            HttpStatusCode.ServiceUnavailable
        );
        var resolved = await Call(
            "POST",
            "/api/projects/resolve-directory",
            new { nodeId = "master" }
        );
        Assert.Equal(CodeNativePaths.Transport(h.Work), resolved["rootPath"]!.GetValue<string>());
        var project = (
            await Call(
                "POST",
                "/api/projects",
                new
                {
                    nodeId = "master",
                    rootPath = root + "/child/../.",
                    name = "Example",
                }
            )
        )["project"]!;
        Assert.Equal(root, project["rootPath"]!.GetValue<string>());
        var projectId = Id(project);
        Assert.Equal(
            projectId,
            Id(
                (await Call("POST", "/api/projects", new { nodeId = "master", rootPath = root }))[
                    "project"
                ]!
            )
        );
        await Call(
            "PATCH",
            $"/api/projects/{projectId}",
            new { archived = "false" },
            HttpStatusCode.BadRequest
        );
        var work = await Work(projectId);
        var tabs = $"/api/project-sessions/{work}/tabs";
        var terminal = (
            await Call("POST", tabs, new { type = "terminal", requestId = "terminal-retry" })
        )["tab"]!;
        Assert.Equal(
            Id(terminal),
            Id(
                (await Call("POST", tabs, new { type = "terminal", requestId = "terminal-retry" }))[
                    "tab"
                ]!
            )
        );
        await Call(
            "POST",
            tabs,
            new { type = "code", requestId = "terminal-retry" },
            HttpStatusCode.Conflict
        );
        var agents = await Task.WhenAll(
            Enumerable
                .Range(0, 2)
                .Select(_ => Call("POST", tabs, new { type = "agent", requestId = "agent-retry" }))
        );
        Assert.Equal(Id(agents[0]["tab"]!), Id(agents[1]["tab"]!));
        var runtimeId = agents[0]["tab"]!["resourceId"]!.GetValue<string>();
        var history = await Call("GET", $"/api/sessions/{Uri.EscapeDataString(runtimeId)}/history");
        Assert.Equal("master", history["session"]!["currentNode"]!.GetValue<string>());
        Assert.Equal(directory, history["session"]!["cwd"]!.GetValue<string>());
        // The first committed authority already owns the target, before any Chat can run it.
        var authority = JsonNode.Parse(
            await File.ReadAllTextAsync(
                Path.Combine(h.Data, "state", "sessions", runtimeId + ".json")
            )
        )!;
        Assert.Equal(directory, authority["cwd"]!.GetValue<string>());
        await Call(
            "PATCH",
            $"/api/project-tabs/{Id(agents[0]["tab"]!)}",
            new { resourceId = "main" },
            HttpStatusCode.BadRequest
        );
        var secondWork = await Work(projectId);
        await Call(
            "POST",
            $"/api/project-sessions/{secondWork}/tabs",
            new
            {
                type = "agent",
                existingSessionId = runtimeId,
                requestId = "linked-twice",
            },
            HttpStatusCode.Conflict
        );
        Assert.Empty(
            (await Call("GET", "/api/projects"))["projects"]![0]!["sessions"]!
                .AsArray()
                .Single(session => Id(session!) == secondWork)!["tabs"]!.AsArray()
        );

        var standalone = (
            await Call("POST", "/api/sessions", new { sessionId = "attach-project" })
        )["sessionId"]!.GetValue<string>();
        await Call(
            "POST",
            $"/api/project-sessions/{secondWork}/tabs",
            new { type = "agent", existingSessionId = standalone },
            HttpStatusCode.BadRequest
        );
        await Call("POST", $"/api/sessions/{standalone}/cwd", new { cwd = directory });
        var linked = (
            await Call(
                "POST",
                $"/api/project-sessions/{secondWork}/tabs",
                new { type = "agent", existingSessionId = standalone }
            )
        )["tab"]!;
        Assert.Equal(standalone, linked["resourceId"]!.GetValue<string>());

        Directory.Move(directory, directory + ".away");
        await Call(
            "POST",
            tabs,
            new { type = "agent", requestId = "pending-retry" },
            HttpStatusCode.NotFound
        );
        var pending = (await Call("GET", "/api/projects"))["projects"]![0]!["sessions"]!
            .AsArray()
            .Single(session => Id(session!) == work)!["tabs"]!
            .AsArray()
            .Single(tab => tab!["requestId"]?.ToString() == "pending-retry")!;
        Assert.Equal("pending", pending["state"]!.ToString());
        Assert.False(
            File.Exists(
                Path.Combine(
                    h.Data,
                    "state",
                    "sessions",
                    pending["resourceId"]!.ToString() + ".json"
                )
            )
        );
        await h.Stop();
        Directory.Move(directory + ".away", directory);
        h.Start();
        await h.Ready();
        var recovered = (
            await Call("POST", tabs, new { type = "agent", requestId = "pending-retry" })
        )["tab"]!;
        Assert.Equal(Id(pending), Id(recovered));
        Assert.Equal(pending["resourceId"]!.ToString(), recovered["resourceId"]!.ToString());
        Assert.Equal("ready", recovered["state"]!.ToString());
        Assert.Equal(projectId, Id((await Call("GET", "/api/projects?limit=1"))["projects"]![0]!));
        await Call("DELETE", $"/api/project-tabs/{Id(linked)}");
        await Call("GET", $"/api/sessions/{standalone}/history");
        await Call("PATCH", $"/api/projects/{projectId}", new { archived = true });
        await Call("POST", $"/api/projects/{projectId}/sessions", new { }, HttpStatusCode.NotFound);
        Assert.Equal(
            projectId,
            Id(
                (await Call("POST", "/api/projects", new { nodeId = "master", rootPath = root }))[
                    "project"
                ]!
            )
        );
        await h.Stop();
    }

    [Fact]
    public void Projects_open_the_Source_schema_without_replacing_existing_membership()
    {
        using var temp = new TempDirectory();
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        using (
            var db = new SqliteConnection(
                new SqliteConnectionStringBuilder
                {
                    DataSource = Path.Combine(temp.Path, "state", "projects.sqlite"),
                }.ToString()
            )
        )
        {
            db.Open();
            using var command = db.CreateCommand();
            command.CommandText = """
                CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,node_id TEXT NOT NULL,root_path TEXT NOT NULL,created_at INTEGER NOT NULL,archived INTEGER NOT NULL DEFAULT 0,UNIQUE(node_id,root_path));
                CREATE TABLE work_sessions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,created_at INTEGER NOT NULL,archived INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE work_tabs(id TEXT PRIMARY KEY,work_session_id TEXT NOT NULL REFERENCES work_sessions(id),type TEXT NOT NULL,title TEXT NOT NULL,resource_id TEXT,request_id TEXT UNIQUE,created_at INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'ready');
                INSERT INTO projects VALUES('p','Existing','remote','/srv/project',1,0);
                INSERT INTO work_sessions VALUES('s','p','Work',2,0);
                INSERT INTO work_tabs VALUES('t','s','agent','Agent','existing-agent','original-request',3,'ready');
                PRAGMA user_version=1;
                """;
            command.ExecuteNonQuery();
        }
        using (var store = new ProjectStore(temp.Path))
        {
            Assert.Equal(
                "existing-agent",
                store.List(100, 0)[0]!["sessions"]![0]!["tabs"]![0]!["resourceId"]!.ToString()
            );
            Assert.Equal(
                "t",
                store.CreateTab("s", "agent", "Retry", "original-request", "main")["id"]!.ToString()
            );
            var otherHost = store.CreateProject("Other", "other", "/srv/project");
            Assert.NotEqual("p", otherHost["id"]!.ToString());
        }
        using var reopened = new ProjectStore(temp.Path);
        Assert.Equal(2, reopened.List(100, 0).Count);
        Assert.Equal("existing-agent", reopened.GetTab("t")!["resourceId"]!.ToString());
    }
}
