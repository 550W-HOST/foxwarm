using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Code;
using Foxwarm.Projects;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Channels.WebUi;

internal sealed partial class WebUIChannel
{
    private ProjectStore projects = null!;
    private readonly ConcurrentDictionary<string, Lazy<Task<JsonObject>>> projectCreations = new();

    private static string ProjectString(JsonNode? value, string name, int maximum = 256)
    {
        var text = SessionWait.Text(value);
        if (
            text is null
            || string.IsNullOrWhiteSpace(text)
            || text.Length > maximum
            || text.Contains('\0')
        )
            throw new InvalidDataException(
                $"{name} must be a non-empty string of at most {maximum} characters."
            );
        return text.Trim();
    }

    private static bool? ProjectArchived(JsonObject body)
    {
        if (!body.ContainsKey("archived"))
            return null;
        if (body["archived"] is JsonValue value && value.TryGetValue<bool>(out var flag))
            return flag;
        throw new InvalidDataException("archived must be a boolean.");
    }

    private static async Task<JsonObject> ProjectBody(HttpContext context) =>
        await JsonNode.ParseAsync(context.Request.Body, cancellationToken: context.RequestAborted)
            as JsonObject
        ?? throw new InvalidDataException("A JSON object is required.");

    private static void ProjectRoute(
        WebApplication app,
        string method,
        string route,
        Func<HttpContext, Task<JsonNode>> action
    )
    {
        // HttpServer's administrator middleware owns these routes. They are not
        // part of the scoped WebUI identity allowlist.
        app.MapMethods(
            route,
            [method],
            async (HttpContext context) =>
            {
                try
                {
                    await context.Response.WriteAsJsonAsync(
                        await action(context),
                        context.RequestAborted
                    );
                }
                catch (Exception error)
                    when (error
                            is InvalidDataException
                                or JsonException
                                or IOException
                                or InvalidOperationException
                                or CodeServiceException
                                or SqliteException
                                or UnauthorizedAccessException
                    )
                {
                    var status = error switch
                    {
                        CodeServiceException service => service.Status,
                        SqliteException { SqliteErrorCode: 19 } => 409,
                        SqliteException => 500,
                        _ when error.Message.Contains(
                                "not found",
                                StringComparison.OrdinalIgnoreCase
                            ) => 404,
                        _ when error.Message.Contains("already", StringComparison.OrdinalIgnoreCase)
                                || error.Message.Contains(
                                    "in progress",
                                    StringComparison.OrdinalIgnoreCase
                                ) => 409,
                        _ => 400,
                    };
                    context.Response.StatusCode = status;
                    await context.Response.WriteAsJsonAsync(
                        new { error = error.Message },
                        context.RequestAborted
                    );
                }
            }
        );
    }

    private void RegisterProjectRoutes(WebApplication app)
    {
        projects = new(Path.Combine(sessions.DataRoot, "state", "projects.sqlite"));
        app.Lifetime.ApplicationStopped.Register(projects.Dispose);
        static string Id(HttpContext context) => context.Request.RouteValues["id"]!.ToString()!;
        ProjectRoute(
            app,
            "GET",
            "/api/projects",
            context =>
            {
                var limit = int.TryParse(context.Request.Query["limit"], out var value)
                    ? Math.Clamp(value, 1, 100)
                    : 100;
                var offset = int.TryParse(context.Request.Query["offset"], out value)
                    ? Math.Clamp(value, 0, 100000)
                    : 0;
                var rows = projects.List(limit, offset);
                return Task.FromResult<JsonNode>(
                    new JsonObject
                    {
                        ["projects"] = rows,
                        ["nextOffset"] = rows.Count == limit ? offset + limit : null,
                    }
                );
            }
        );
        ProjectRoute(
            app,
            "POST",
            "/api/projects/resolve-directory",
            async context =>
            {
                var body = await ProjectBody(context);
                var node = ProjectString(body["nodeId"], "nodeId");
                return new JsonObject
                {
                    ["nodeId"] = node,
                    ["rootPath"] = await ResolveProjectRoot(
                        node,
                        body["rootPath"],
                        context.RequestAborted
                    ),
                };
            }
        );
        ProjectRoute(
            app,
            "POST",
            "/api/projects",
            async context =>
            {
                var body = await ProjectBody(context);
                var node = ProjectString(body["nodeId"], "nodeId");
                var root = await ResolveProjectRoot(node, body["rootPath"], context.RequestAborted);
                var name = body["name"] is null
                    ? Path.GetFileName(root.TrimEnd('/'))
                    : ProjectString(body["name"], "name");
                return new JsonObject
                {
                    ["project"] = projects.CreateProject(
                        string.IsNullOrEmpty(name) ? node : name,
                        node,
                        root
                    ),
                };
            }
        );
        ProjectRoute(
            app,
            "PATCH",
            "/api/projects/{id}",
            async context =>
            {
                var body = await ProjectBody(context);
                return new JsonObject
                {
                    ["project"] = projects.UpdateProject(
                        Id(context),
                        body.ContainsKey("name") ? ProjectString(body["name"], "name") : null,
                        ProjectArchived(body)
                    ),
                };
            }
        );
        ProjectRoute(
            app,
            "POST",
            "/api/projects/{id}/sessions",
            async context =>
            {
                var body = await ProjectBody(context);
                return new JsonObject
                {
                    ["session"] = projects.CreateSession(
                        Id(context),
                        body["title"] is null
                            ? "New session"
                            : ProjectString(body["title"], "title")
                    ),
                };
            }
        );
        ProjectRoute(
            app,
            "PATCH",
            "/api/project-sessions/{id}",
            async context =>
            {
                var body = await ProjectBody(context);
                return new JsonObject
                {
                    ["session"] = projects.UpdateSession(
                        Id(context),
                        body.ContainsKey("title") ? ProjectString(body["title"], "title") : null,
                        ProjectArchived(body)
                    ),
                };
            }
        );
        ProjectRoute(
            app,
            "POST",
            "/api/project-sessions/{id}/tabs",
            async context => new JsonObject
            {
                ["tab"] = await CreateProjectTab(
                    Id(context),
                    await ProjectBody(context),
                    context.RequestAborted
                ),
            }
        );
        ProjectRoute(
            app,
            "PATCH",
            "/api/project-tabs/{id}",
            async context =>
            {
                var body = await ProjectBody(context);
                var tab =
                    projects.GetTab(Id(context))
                    ?? throw new InvalidDataException("Tab not found.");
                var resource = body.ContainsKey("resourceId")
                    ? ProjectString(body["resourceId"], "resourceId", 512)
                    : null;
                if (
                    ProjectStore.Text(tab, "type") == "agent"
                    && resource is not null
                    && resource != ProjectStore.Text(tab, "resourceId")
                )
                    throw new InvalidDataException("Agent tab ownership cannot be changed.");
                return new JsonObject
                {
                    ["tab"] = projects.UpdateTab(
                        Id(context),
                        body.ContainsKey("title") ? ProjectString(body["title"], "title") : null,
                        resource
                    ),
                };
            }
        );
        ProjectRoute(
            app,
            "DELETE",
            "/api/project-tabs/{id}",
            context =>
            {
                if (projectCreations.ContainsKey(Id(context)))
                    throw new InvalidDataException("Tab creation is in progress.");
                projects.DeleteTab(Id(context));
                return Task.FromResult<JsonNode>(new JsonObject { ["success"] = true });
            }
        );
    }

    private async Task<string> ResolveProjectRoot(
        string node,
        JsonNode? requested,
        CancellationToken token
    )
    {
        string root;
        if (requested is null || SessionWait.Text(requested) == "")
        {
            if (node == "master")
                root = CodeNativePaths.Transport(sessions.AgentDirectory("main"));
            else
            {
                // A read-only native Node probe can precede the first Session.
                // It does not allocate an owner or admit executable tools.
                var value = await sessions.Nodes.ExecuteAsync(
                    node,
                    "get_default_cwd",
                    new(),
                    "__project_cwd_probe__",
                    "main",
                    "",
                    null,
                    false,
                    token
                );
                root =
                    SessionWait.Text(value)
                    ?? SessionWait.Text((value as JsonObject)?["output"])
                    ?? throw new InvalidDataException(
                        "Node did not report its default working directory."
                    );
            }
        }
        else
            root =
                SessionWait.Text(requested)
                ?? throw new InvalidDataException("Project directory must be a string.");
        if (
            root.Length > 4096
            || root.Contains('\\')
            || root.Contains('\0')
            || !root.StartsWith('/')
        )
            throw new InvalidDataException("Project directory must be an absolute POSIX path.");
        root = CodeFileService.PathValue(root);
        JsonObject stat;
        if (node == "master")
        {
            stat = CodeFileService.StatFile(root);
            if (((int)(SessionWait.Number(stat["type"]) ?? 0) & 2) == 0)
                throw new InvalidDataException("Project path is not a directory.");
            _ = CodeFileService.ReadDirectory(root);
        }
        else
        {
            var target = sessions.Nodes.Service(node, "vscode-fs");
            stat = await sessions.Nodes.RequestServiceAsync(
                target,
                "stat",
                new() { ["path"] = root },
                token
            );
            if (((int)(SessionWait.Number(stat["type"]) ?? 0) & 2) == 0)
                throw new InvalidDataException("Project path is not a directory.");
            await sessions.Nodes.RequestServiceAsync(
                target,
                "read-directory",
                new() { ["path"] = root },
                token
            );
        }
        return root;
    }

    private async Task<JsonObject> CreateProjectTab(
        string workSessionId,
        JsonObject body,
        CancellationToken token
    )
    {
        var work = projects.GetSession(workSessionId);
        if (work is null || work["archived"]!.GetValue<bool>())
            throw new InvalidDataException("Workspace session not found or archived.");
        var project = projects.GetProject(ProjectStore.Text(work, "projectId")!);
        if (project is null || project["archived"]!.GetValue<bool>())
            throw new InvalidDataException("Project not found or archived.");
        var type = ProjectString(body["type"], "type");
        if (type is not ("agent" or "terminal" or "code"))
            throw new InvalidDataException("Invalid tab type.");
        var title = body["title"] is null
            ? type == "agent"
                ? "Agent"
                : type == "terminal"
                    ? "Terminal"
                    : "Code"
            : ProjectString(body["title"], "title");
        var request =
            body.ContainsKey("requestId") ? ProjectString(body["requestId"], "requestId", 128)
            : type == "agent" ? Guid.NewGuid().ToString()
            : null;
        var node = ProjectStore.Text(project, "nodeId")!;
        var root = ProjectStore.Text(project, "rootPath")!;
        SessionOwner? existing = null;
        if (type == "agent" && body.ContainsKey("existingSessionId"))
        {
            existing =
                await sessions.GetExistingAsync(
                    ProjectString(body["existingSessionId"], "existingSessionId", 512)
                ) ?? throw new InvalidDataException("Existing Agent session not found.");
            RequireProjectPlacement(existing, node, root);
        }
        var previous = request is null ? null : projects.FindRequest(request);
        var agent =
            type == "agent"
                ? existing?.Agent
                    ?? (
                        body.ContainsKey("agentId") ? ProjectString(body["agentId"], "agentId", 128)
                        : previous is null ? "main"
                        : ProjectStore.Text(previous, "agentId") ?? "main"
                    )
                : null;
        if (agent is not null)
        {
            if (!sessions.Agents().Contains(agent))
                throw new InvalidDataException("Agent not found.");
            if (sessions.BoundNode(agent) is { } bound && bound != node)
                throw new InvalidDataException(
                    $"Agent is bound to node {bound}; choose a project on that node."
                );
        }
        if (existing is not null)
            return projects.LinkExisting(workSessionId, title, request, existing.Id, agent!);
        var tab = projects.CreateTab(workSessionId, type, title, request, agent);
        if (type != "agent" || ProjectStore.Text(tab, "state") == "ready")
            return tab;
        var id = ProjectStore.Text(tab, "id")!;
        var sessionName = "project_" + id.Replace("-", "");
        var runtimeId = SessionIdentity.Build(agent!, sessionName);
        if (ProjectStore.Text(tab, "resourceId") is { } resource && resource != runtimeId)
            throw new InvalidDataException("Request ID was already used with a different Agent.");
        var pending = projectCreations.GetOrAdd(
            id,
            _ => new(() => InitializeProjectAgent(tab, agent!, sessionName, runtimeId, node, root))
        );
        try
        {
            return (JsonObject)(await pending.Value).DeepClone();
        }
        finally
        {
            projectCreations.TryRemove(
                new KeyValuePair<string, Lazy<Task<JsonObject>>>(id, pending)
            );
        }
    }

    private void RequireProjectPlacement(SessionOwner owner, string node, string root)
    {
        var placement = sessions.ExecutionPlacement(owner);
        var cwd =
            node == "master" && placement.Cwd is not null
                ? CodeNativePaths.Transport(placement.Cwd)
                : placement.Cwd;
        if (placement.Node != node || cwd != root)
            throw new InvalidDataException(
                "Agent session must already use the project node and directory; its target was not rebound."
            );
    }

    private async Task<JsonObject> InitializeProjectAgent(
        JsonObject tab,
        string agent,
        string name,
        string runtimeId,
        string node,
        string root
    )
    {
        var id = ProjectStore.Text(tab, "id")!;
        projects.UpdateTab(id, resourceId: runtimeId);
        var owner = await sessions.GetExistingAsync(runtimeId);
        if (owner is null)
        {
            await ResolveProjectRoot(node, JsonValue.Create(root), CancellationToken.None);
            owner = await sessions.CreateNamedAsync(
                agent,
                name,
                null,
                null,
                initialNode: node,
                initialCwd: node == "master" ? CodeNativePaths.Native(root) : root
            );
        }
        sessions.RequireNodeBoundary(owner, node);
        if (node != "master")
            _ = sessions.Nodes.Service(node, "vscode-fs");
        RequireProjectPlacement(owner, node, root);
        return projects.UpdateTab(id, state: "ready");
    }
}
