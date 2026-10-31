using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Code;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Channels.WebUi;

internal sealed partial class WebUIChannel
{
    // Reservation, runtime creation and deletion are serialized together. A retry
    // reuses the recorded runtime identity even after a lost response or restart.
    private readonly SemaphoreSlim projectGate = new(1, 1);

    private static string ProjectString(JsonNode? value, string name, int max = 256)
    {
        if (
            value is not JsonValue node
            || !node.TryGetValue<string>(out var text)
            || string.IsNullOrWhiteSpace(text)
            || text.Length > max
            || text.Contains('\0')
        )
            throw new InvalidDataException(
                $"{name} must be a non-empty string of at most {max} characters."
            );
        return text.Trim();
    }

    private static string? ProjectOptional(JsonObject body, string name, int max = 256) =>
        body.ContainsKey(name) ? ProjectString(body[name], name, max) : null;

    private static bool? ProjectArchived(JsonObject body)
    {
        if (!body.ContainsKey("archived"))
            return null;
        if (body["archived"] is JsonValue value && value.TryGetValue<bool>(out var flag))
            return flag;
        throw new InvalidDataException("archived must be a boolean.");
    }

    private async Task<string> ProjectRootAsync(
        string node,
        JsonNode? requested,
        CancellationToken token
    )
    {
        string? root;
        if (requested is null || SessionWait.Text(requested) == "")
        {
            if (node == "master")
                root = sessions.AgentDirectory("main");
            else
            {
                await sessions.NodeProviders.RefreshAsync(node, token);
                root = sessions.NodeProviders.DefaultCwd(node);
                if (
                    root is null
                    && sessions
                        .Nodes.Definitions(node)
                        .Any(tool => SessionWait.Text(tool?["name"]) == "get_default_cwd")
                )
                {
                    var result = await sessions.Nodes.ExecuteAsync(
                        node,
                        "get_default_cwd",
                        new(),
                        "main",
                        "main",
                        "master",
                        null,
                        false,
                        token
                    );
                    root =
                        SessionWait.Text(result)
                        ?? SessionWait.Text((result as JsonObject)?["output"]);
                }
                if (string.IsNullOrWhiteSpace(root))
                    throw new InvalidDataException(
                        "Node does not provide a default project directory; enter an absolute path."
                    );
            }
        }
        else
            root = ProjectString(requested, "rootPath", 4096);
        if (root.Contains('\0') || root.Length > 4096)
            throw new InvalidDataException("Invalid project directory.");
        if (node == "master")
            root = CodeNativePaths.Transport(CodeNativePaths.Native(root));
        if (root.Contains('\\'))
            throw new InvalidDataException(
                "Project directory must use an absolute slash-based path."
            );
        root = CodeFileService.PathValue(root);
        JsonObject stat;
        if (node == "master")
        {
            stat = CodeFileService.StatFile(root);
            _ = CodeFileService.ReadDirectory(root);
        }
        else
        {
            // Both reads use one admitted service generation; reconnects cannot
            // silently resolve the same project against a replacement machine.
            var target = sessions.Nodes.Service(node, "vscode-fs");
            stat = await sessions.Nodes.RequestServiceAsync(
                target,
                "stat",
                new() { ["path"] = root },
                token
            );
            _ = await sessions.Nodes.RequestServiceAsync(
                target,
                "read-directory",
                new() { ["path"] = root },
                token
            );
        }
        if ((Convert.ToInt32(SessionWait.Number(stat["type"]) ?? 0) & 2) != 2)
            throw new InvalidDataException("Project path is not a directory.");
        return root;
    }

    private void RegisterProjectRoutes(WebApplication app)
    {
        var store = new ProjectStore(sessions.DataRoot);
        app.Lifetime.ApplicationStopped.Register(store.Dispose);

        async Task<IResult> Handle(
            HttpContext context,
            Func<HttpContext, JsonObject, Task<object>> handler
        )
        {
            try
            {
                var body = new JsonObject();
                if (
                    context.Request.Method is "POST" or "PATCH"
                    && context.Request.ContentLength != 0
                )
                    body =
                        await JsonNode.ParseAsync(
                            context.Request.Body,
                            cancellationToken: context.RequestAborted
                        ) as JsonObject
                        ?? throw new InvalidDataException("Project input must be an object.");
                await projectGate.WaitAsync(context.RequestAborted);
                try
                {
                    if (context.Request.Method != "GET" && !sessions.Accepting)
                        return Results.StatusCode(503);
                    return Results.Ok(await handler(context, body));
                }
                finally
                {
                    projectGate.Release();
                }
            }
            catch (CodeServiceException error)
            {
                return Results.Json(
                    new { error = error.Message, code = error.Code },
                    statusCode: error.Status
                );
            }
            catch (Exception error)
                when (error
                        is JsonException
                            or InvalidDataException
                            or InvalidOperationException
                            or KeyNotFoundException
                            or IOException
                            or ArgumentException
                            or UnauthorizedAccessException
                            or SqliteException
                )
            {
                var status =
                    error is KeyNotFoundException ? 404
                    : error is SqliteException { SqliteErrorCode: 19 }
                    || error is ProjectConflictException
                        ? 409
                    : 400;
                return Results.Json(new { error = error.Message }, statusCode: status);
            }
        }

        void Route(
            string method,
            string path,
            Func<HttpContext, JsonObject, Task<object>> handler
        ) =>
            app.MapMethods(
                path,
                [method],
                (Func<HttpContext, Task<IResult>>)(context => Handle(context, handler))
            );
        static Task<object> Value(object value) => Task.FromResult(value);
        static string Id(HttpContext context) =>
            ProjectString(
                JsonValue.Create(context.Request.RouteValues["id"]?.ToString()),
                "id",
                128
            );

        Route(
            "GET",
            "/api/projects",
            (context, _) =>
            {
                var limit = Math.Clamp(
                    int.TryParse(context.Request.Query["limit"], out var n) ? n : 100,
                    1,
                    100
                );
                var offset = Math.Clamp(
                    int.TryParse(context.Request.Query["offset"], out var m) ? m : 0,
                    0,
                    100000
                );
                var projects = store.List(limit, offset);
                return Value(
                    new
                    {
                        projects,
                        nextOffset = projects.Count == limit ? (int?)(offset + limit) : null,
                    }
                );
            }
        );
        Route(
            "POST",
            "/api/projects/resolve-directory",
            async (context, body) =>
            {
                var nodeId = ProjectString(body["nodeId"], "nodeId");
                return new
                {
                    nodeId,
                    rootPath = await ProjectRootAsync(
                        nodeId,
                        body["rootPath"],
                        context.RequestAborted
                    ),
                };
            }
        );
        Route(
            "POST",
            "/api/projects",
            async (context, body) =>
            {
                var node = ProjectString(body["nodeId"], "nodeId");
                var root = await ProjectRootAsync(node, body["rootPath"], context.RequestAborted);
                var name =
                    ProjectOptional(body, "name")
                    ?? (Path.GetFileName(root) is { Length: > 0 } basename ? basename : node);
                return new { project = store.CreateProject(name, node, root) };
            }
        );
        Route(
            "PATCH",
            "/api/projects/{id}",
            (context, body) =>
                Value(
                    new
                    {
                        project = store.UpdateProject(
                            Id(context),
                            ProjectOptional(body, "name"),
                            ProjectArchived(body)
                        ),
                    }
                )
        );
        Route(
            "POST",
            "/api/projects/{id}/sessions",
            (context, body) =>
                Value(
                    new
                    {
                        session = store.CreateSession(
                            Id(context),
                            ProjectOptional(body, "title") ?? "New session"
                        ),
                    }
                )
        );
        Route(
            "PATCH",
            "/api/project-sessions/{id}",
            (context, body) =>
                Value(
                    new
                    {
                        session = store.UpdateSession(
                            Id(context),
                            ProjectOptional(body, "title"),
                            ProjectArchived(body)
                        ),
                    }
                )
        );
        Route(
            "POST",
            "/api/project-sessions/{id}/tabs",
            async (context, body) =>
            {
                var workSession = store.GetSession(Id(context));
                if (workSession is null || workSession["archived"]!.GetValue<bool>())
                    throw new KeyNotFoundException("Workspace session not found or archived.");
                var project = store.GetProject(workSession["projectId"]!.GetValue<string>());
                if (project is null || project["archived"]!.GetValue<bool>())
                    throw new KeyNotFoundException("Project not found or archived.");
                var node = project["nodeId"]!.GetValue<string>();
                var root = project["rootPath"]!.GetValue<string>();
                var type = ProjectString(body["type"], "type");
                if (type is not ("agent" or "terminal" or "code"))
                    throw new InvalidDataException("Invalid tab type.");
                var title =
                    ProjectOptional(body, "title")
                    ?? (
                        type == "agent" ? "Agent"
                        : type == "terminal" ? "Terminal"
                        : "Code"
                    );
                var request =
                    ProjectOptional(body, "requestId", 128)
                    ?? (type == "agent" ? Guid.NewGuid().ToString() : null);
                var existingId =
                    type == "agent" ? ProjectOptional(body, "existingSessionId", 512) : null;
                var existing = existingId is null
                    ? null
                    : await sessions.GetExistingAsync(existingId);
                if (existingId is not null && existing is null)
                    throw new KeyNotFoundException("Existing Agent session not found.");
                if (existing is not null)
                {
                    var placement = sessions.ExecutionPlacement(existing);
                    if (
                        placement.Node != node
                        || placement.Cwd is null
                        || CodePath(placement.Cwd, node) != root
                    )
                        throw new InvalidDataException(
                            "Existing Agent session must already use the project node and directory."
                        );
                }
                var previous = request is null ? null : store.FindRequest(request);
                var agent =
                    type == "agent"
                        ? existing?.Agent
                            ?? ProjectOptional(body, "agentId", 128)
                            ?? SessionWait.Text(previous?["agentId"])
                            ?? "main"
                        : null;
                if (agent is not null)
                {
                    AgentCatalog.ValidateName(agent);
                    if (sessions.BoundNode(agent) is { } bound && bound != node)
                        throw new InvalidDataException(
                            $"Agent is bound to node {bound}; choose a project on that node."
                        );
                }
                var sessionId = workSession["id"]!.GetValue<string>();
                if (existing is not null)
                    return new
                    {
                        tab = store.LinkExisting(
                            sessionId,
                            title,
                            request,
                            existing.Id,
                            existing.Agent
                        ),
                    };
                var tab = store.CreateTab(sessionId, type, title, request, agent);
                if (type != "agent")
                    return new { tab };
                var name = "project_" + tab["id"]!.GetValue<string>().Replace("-", "");
                var runtimeId = SessionIdentity.Build(agent!, name);
                if (
                    tab["resourceId"] is not null
                    && SessionWait.Text(tab["resourceId"]) != runtimeId
                )
                    throw new ProjectConflictException(
                        "Request ID was already used with a different Agent."
                    );
                if (tab["state"]!.GetValue<string>() == "ready")
                    return new { tab };
                store.UpdateTab(tab["id"]!.GetValue<string>(), resource: runtimeId);
                var owner = await sessions.GetExistingAsync(runtimeId);
                if (owner is null)
                {
                    await ProjectRootAsync(node, JsonValue.Create(root), context.RequestAborted);
                    owner = await sessions.CreateNamedAsync(
                        agent!,
                        name,
                        null,
                        null,
                        initialNode: node,
                        initialCwd: node == "master" ? CodeNativePaths.Native(root) : root
                    );
                }
                var target = sessions.ExecutionPlacement(owner);
                if (target.Node != node || target.Cwd is null || CodePath(target.Cwd, node) != root)
                    throw new InvalidDataException(
                        "Agent session target changed during creation; it was not rebound."
                    );
                return new { tab = store.UpdateTab(tab["id"]!.GetValue<string>(), state: "ready") };
            }
        );
        Route(
            "PATCH",
            "/api/project-tabs/{id}",
            (context, body) =>
            {
                var id = Id(context);
                var tab = store.GetTab(id) ?? throw new KeyNotFoundException("Tab not found.");
                var resource = ProjectOptional(body, "resourceId", 512);
                if (
                    tab["type"]!.GetValue<string>() == "agent"
                    && resource is not null
                    && resource != SessionWait.Text(tab["resourceId"])
                )
                    throw new InvalidDataException("Agent tab ownership cannot be changed.");
                return Value(
                    new { tab = store.UpdateTab(id, ProjectOptional(body, "title"), resource) }
                );
            }
        );
        Route(
            "DELETE",
            "/api/project-tabs/{id}",
            (context, _) =>
            {
                if (!store.DeleteTab(Id(context)))
                    throw new KeyNotFoundException("Tab not found.");
                return Value(new { success = true });
            }
        );
    }

    private static string CodePath(string path, string node) =>
        CodeFileService.PathValue(node == "master" ? CodeNativePaths.Transport(path) : path);
}
