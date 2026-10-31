using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Code;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm;

// One stateless read route, not an MCP context or authority for the other Code APIs.
internal static class McpNodeFileDownload
{
    private const string Route = "/api/vscode-web/fs/read-file";

    internal static bool IsRequest(HttpRequest request) =>
        request.Method == "GET" && request.Path == Route;

    internal static void Register(
        WebApplication app,
        SessionManager sessions,
        AccessConfiguration access,
        Func<HttpRequest, bool> isAdmin,
        Func<HttpContext, Task> adminDownload
    ) =>
        app.MapGet(
            Route,
            async context =>
            {
                if (isAdmin(context.Request))
                {
                    await adminDownload(context);
                    return;
                }
                var header = context.Request.Headers.Authorization;
                var bearer =
                    header.Count == 1
                        ? Regex.Match(
                            header[0] ?? "",
                            @"^Bearer ([A-Za-z0-9._~+/-]+={0,2})$",
                            RegexOptions.IgnoreCase
                        )
                        : null;
                var principal =
                    bearer?.Success == true
                        ? McpExternalPrincipal.Authenticate(access, bearer.Groups[1].Value)
                        : null;
                if (principal is null)
                {
                    context.Response.StatusCode =
                        bearer?.Success == true
                        && access.Authenticate(bearer.Groups[1].Value) is not null
                            ? 403
                            : 401;
                    await context.Response.WriteAsJsonAsync(
                        new
                        {
                            error = context.Response.StatusCode == 403
                                ? "Forbidden"
                                : "Unauthorized",
                        }
                    );
                    return;
                }
                var query = context.Request.Query;
                var node = query["nodeId"].Count == 1 ? query["nodeId"].ToString() : "";
                var path = query["path"].Count == 1 ? query["path"].ToString() : "";
                if (
                    !Regex.IsMatch(node, "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
                    || path.Contains('\0')
                    || !(
                        path.StartsWith('/')
                        || Regex.IsMatch(path, @"^[A-Za-z]:[\\/]|^\\\\[^\\]+\\[^\\]+")
                    )
                )
                {
                    context.Response.StatusCode = 400;
                    await context.Response.WriteAsJsonAsync(
                        new
                        {
                            error = "Explicit nodeId and a Node-native absolute path are required.",
                        }
                    );
                    return;
                }
                var args = new JsonObject { ["filePath"] = path };
                var permission = new ToolAuthorizationRequest(
                    "node",
                    "read",
                    null,
                    args,
                    [new("filePath", path, null, node)],
                    null,
                    null,
                    node,
                    sessions.ToolWorkspace,
                    null,
                    null,
                    Principal: "external",
                    ExternalId: principal.Id,
                    NodeTargets: ToolAuthorizationNodeEffects.Resolve("node", "read", node, args)
                );
                void AssertRead()
                {
                    if (
                        !principal.Current
                        || node == "master"
                        || !sessions.Nodes.SupportsExternalRead(node)
                        || !ToolAuthorizationEvaluation
                            .Evaluate(sessions.Authorization.Load(), permission)
                            .Allowed
                    )
                        throw new McpInboundSafeException("File download is not permitted.");
                }
                try
                {
                    await sessions.Authorization.LoadAsync(context.RequestAborted);
                    AssertRead();
                    var target = sessions.Nodes.Service(node, "vscode-fs");
                    var result = await sessions.Nodes.RequestServiceAsync(
                        target,
                        "read-file",
                        new() { ["path"] = path },
                        context.RequestAborted,
                        beforeSend: AssertRead
                    );
                    AssertRead();
                    var bytes = CodeWorkbench.Binary(result, CodeFileService.MaxFileBytes);
                    context.Response.ContentType = "application/octet-stream";
                    context.Response.Headers.CacheControl = "no-store";
                    context.Response.Headers.XContentTypeOptions = "nosniff";
                    await context.Response.Body.WriteAsync(bytes, context.RequestAborted);
                }
                catch (OperationCanceledException)
                    when (context.RequestAborted.IsCancellationRequested) { }
                catch (Exception error) when (!context.Response.HasStarted)
                {
                    context.Response.StatusCode = error switch
                    {
                        McpInboundSafeException => 403,
                        CodeServiceException code => code.Status,
                        _ => 503,
                    };
                    await context.Response.WriteAsJsonAsync(
                        new
                        {
                            error = context.Response.StatusCode == 403
                                ? "File download is not permitted."
                                : "File download failed.",
                        }
                    );
                }
            }
        );
}
