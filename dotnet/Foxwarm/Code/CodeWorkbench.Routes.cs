using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.StaticFiles;

namespace Foxwarm.Code;

internal sealed partial class CodeWorkbench
{
    private static readonly FileExtensionContentTypeProvider Mime = new();

    internal bool IsCapabilityRequest(HttpContext context) =>
        context.Request.Method == "GET" && PreFile(context.Request.Path, out _);

    private bool PreFile(PathString requestPath, out string file)
    {
        file = "";
        if (!requestPath.StartsWithSegments("/vscode-web/" + capabilityRoute, out var rest))
            return false;
        var relative = rest.Value?.TrimStart('/') ?? "";
        var segments = relative.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length >= 2 || relative.EndsWith('/'))
            relative = string.Join('/', segments.Skip(1));
        if (relative.Length == 0)
            relative = "index.html";
        var root = Path.Combine(
            assetRoot,
            "out",
            "vs",
            "workbench",
            "contrib",
            "webview",
            "browser",
            "pre"
        );
        file = AssetFile(root, relative) ?? "";
        return file.Length > 0;
    }

    private static string? AssetFile(string root, string? relative)
    {
        if (relative is null || relative.Contains('\0'))
            return null;
        var file = Path.GetFullPath(relative, root);
        return file.StartsWith(
            Path.TrimEndingDirectorySeparator(root) + Path.DirectorySeparatorChar,
            StringComparison.Ordinal
        )
            ? file
            : null;
    }

    private static string? Text(JsonObject? body, string key) =>
        body?[key] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    private static async Task<JsonObject> Body(HttpContext context)
    {
        try
        {
            return await JsonNode.ParseAsync(
                    context.Request.Body,
                    cancellationToken: context.RequestAborted
                ) as JsonObject
                ?? throw new CodeServiceException("InvalidPath", "A JSON object is required.");
        }
        catch (JsonException error)
        {
            throw new CodeServiceException("InvalidPath", "Invalid JSON.", inner: error);
        }
    }

    private static async Task Guard(HttpContext context, Func<Task> action)
    {
        try
        {
            await action();
        }
        catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested) { }
        catch (Exception error) when (!context.Response.HasStarted)
        {
            var mapped = (CodeServiceException)CodeServiceException.FileError(error);
            context.Response.StatusCode = mapped.Status;
            await context.Response.WriteAsJsonAsync(
                new { error = mapped.Message, code = mapped.Code },
                context.RequestAborted
            );
        }
    }

    private static Task Json(HttpContext context, JsonNode value) =>
        context.Response.WriteAsJsonAsync(value, context.RequestAborted);

    private static string Target(HttpContext context, JsonObject? body = null)
    {
        CodeFileService.Node(
            context.Request.Query["nodeId"].FirstOrDefault() ?? Text(body, "nodeId")
        );
        return CodeFileService.PathValue(
            context.Request.Query["path"].FirstOrDefault() ?? Text(body, "path")
        );
    }

    private static string GitTarget(HttpContext context)
    {
        CodeFileService.Node(context.Request.Query["nodeId"].FirstOrDefault());
        return CodeFileService.PathValue(context.Request.Query["workspace"].FirstOrDefault());
    }

    internal void Register(WebApplication app)
    {
        app.MapGet(
            "/api/nodes",
            () =>
                Results.Json(
                    new
                    {
                        nodes = new[]
                        {
                            new
                            {
                                id = "master",
                                type = "master",
                                displayName = "master",
                                online = true,
                                services = hasPty
                                    ? new Dictionary<string, int>
                                    {
                                        ["vscode-fs"] = 1,
                                        ["vscode-git"] = 2,
                                        ["vscode-pty"] = 1,
                                    }
                                    : new Dictionary<string, int>
                                    {
                                        ["vscode-fs"] = 1,
                                        ["vscode-git"] = 2,
                                    },
                            },
                        },
                    }
                )
        );
        app.MapGet(
            "/api/vscode-web/fs/workspace-roots",
            context =>
                Guard(
                    context,
                    () =>
                    {
                        context.Response.Headers.CacheControl = "no-store";
                        return Json(context, Roots());
                    }
                )
        );
        app.MapGet(
            "/api/vscode-web/fs/stat",
            context =>
                Guard(context, () => Json(context, CodeFileService.StatFile(Target(context))))
        );
        app.MapGet(
            "/api/vscode-web/fs/read-directory",
            context =>
                Guard(context, () => Json(context, CodeFileService.ReadDirectory(Target(context))))
        );
        app.MapGet(
            "/api/vscode-web/fs/read-file",
            context =>
                Guard(
                    context,
                    async () =>
                    {
                        var bytes = await CodeFileService.ReadFileAsync(
                            Target(context),
                            context.RequestAborted
                        );
                        context.Response.ContentType = "application/octet-stream";
                        context.Response.Headers.CacheControl = "no-store";
                        await context.Response.Body.WriteAsync(bytes, context.RequestAborted);
                    }
                )
        );
        app.MapPut(
            "/api/vscode-web/fs/write-file",
            context =>
                Guard(
                    context,
                    async () =>
                    {
                        var path = Target(context);
                        if (context.Request.ContentLength > CodeFileService.MaxFileBytes)
                            throw new CodeServiceException(
                                "PayloadTooLarge",
                                "Content exceeds the Code write limit."
                            );
                        if (
                            context.Features.Get<IHttpMaxRequestBodySizeFeature>() is
                            { IsReadOnly: false } size
                        )
                            size.MaxRequestBodySize = CodeFileService.MaxFileBytes + 1;
                        await Json(
                            context,
                            await CodeFileService.WriteFileAsync(
                                path,
                                context.Request.Body,
                                CodeFileService.Bool(
                                    JsonValue.Create(
                                        context.Request.Query["create"].FirstOrDefault()
                                    )
                                ),
                                CodeFileService.Bool(
                                    JsonValue.Create(
                                        context.Request.Query["overwrite"].FirstOrDefault()
                                    )
                                ),
                                context.RequestAborted
                            )
                        );
                    }
                )
        );
        app.MapPost(
            "/api/vscode-web/fs/create-directory",
            context =>
                Guard(
                    context,
                    async () =>
                    {
                        var body = await Body(context);
                        await Json(context, CodeFileService.CreateDirectory(Target(context, body)));
                    }
                )
        );
        app.MapPost(
            "/api/vscode-web/fs/delete",
            context =>
                Guard(
                    context,
                    async () =>
                    {
                        var body = await Body(context);
                        await Json(
                            context,
                            CodeFileService.Delete(
                                Target(context, body),
                                CodeFileService.Bool(body["recursive"])
                            )
                        );
                    }
                )
        );
        app.MapPost(
            "/api/vscode-web/fs/rename",
            context =>
                Guard(
                    context,
                    async () =>
                    {
                        var body = await Body(context);
                        CodeFileService.Node(Text(body, "nodeId"));
                        await Json(
                            context,
                            CodeFileService.Rename(
                                CodeFileService.PathValue(Text(body, "oldPath")),
                                CodeFileService.PathValue(Text(body, "newPath")),
                                CodeFileService.Bool(body["overwrite"])
                            )
                        );
                    }
                )
        );
        app.MapGet(
            "/api/vscode-web/git/status",
            context =>
                Guard(
                    context,
                    async () =>
                    {
                        await Json(
                            context,
                            await CodeGitService.StatusAsync(
                                GitTarget(context),
                                context.RequestAborted
                            )
                        );
                    }
                )
        );
        app.MapGet(
            "/api/vscode-web/git/commit",
            context =>
                Guard(
                    context,
                    async () =>
                    {
                        context.Response.Headers.CacheControl = "no-store";
                        await Json(
                            context,
                            await CodeGitService.CommitAsync(
                                GitTarget(context),
                                context.Request.Query["id"].FirstOrDefault(),
                                context.RequestAborted
                            )
                        );
                    }
                )
        );
        app.MapGet(
            "/api/vscode-web/git/content",
            context =>
                Guard(
                    context,
                    async () =>
                    {
                        var bytes = await CodeGitService.ContentAsync(
                            GitTarget(context),
                            context.Request.Query["path"].FirstOrDefault(),
                            context.Request.Query["side"].FirstOrDefault(),
                            context.Request.Query["ref"].FirstOrDefault(),
                            context.RequestAborted
                        );
                        context.Response.ContentType = "text/plain; charset=utf-8";
                        context.Response.Headers.CacheControl = "no-store";
                        await context.Response.Body.WriteAsync(bytes, context.RequestAborted);
                    }
                )
        );
        app.MapGet(
            "/vscode-web",
            context =>
                Guard(
                    context,
                    async () =>
                    {
                        context.Response.Headers.CacheControl = "no-store";
                        context.Response.ContentType = "text/html; charset=utf-8";
                        if (!Prepared)
                        {
                            context.Response.StatusCode = 503;
                            await context.Response.WriteAsync(
                                "<!doctype html><meta charset=\"utf-8\"><title>Code is unavailable</title><h1>Code assets are not prepared</h1><p>Prepare the official Code workbench assets and restart Code.</p>",
                                context.RequestAborted
                            );
                        }
                        else
                            await context.Response.WriteAsync(
                                Bootstrap(context),
                                context.RequestAborted
                            );
                    }
                )
        );
        app.MapGet(
            "/vscode-web/callback",
            context =>
                context.Response.WriteAsync(
                    "<!doctype html><meta charset=\"utf-8\"><title>Foxwarm Code callback</title><script>window.close();</script>"
                )
        );
        app.MapGet(
            "/vscode-web/static/{**path}",
            context =>
                Guard(
                    context,
                    () =>
                        Static(
                            context,
                            assetRoot,
                            context.Request.RouteValues["path"]?.ToString(),
                            workbench: true
                        )
                )
        );
        foreach (
            var name in (
                hasPty
                    ? new[]
                    {
                        "foxwarm-fs",
                        "foxwarm-scm",
                        "foxwarm-webui",
                        "foxwarm-terminal",
                        "redhat-vscode-yaml",
                    }
                    : new[] { "foxwarm-fs", "foxwarm-scm", "foxwarm-webui", "redhat-vscode-yaml" }
            )
        )
        {
            var root = name == "redhat-vscode-yaml" ? yamlRoot : Path.Combine(extensionRoot, name);
            app.MapGet(
                "/vscode-web/extensions/" + name + "/{**path}",
                context =>
                    Guard(
                        context,
                        () => Static(context, root, context.Request.RouteValues["path"]?.ToString())
                    )
            );
        }
        app.MapGet(
            "/vscode-web/" + capabilityRoute + "/{**path}",
            context =>
                Guard(
                    context,
                    async () =>
                    {
                        if (
                            !Prepared
                            || !PreFile(context.Request.Path, out var file)
                            || !File.Exists(file)
                        )
                        {
                            context.Response.StatusCode = 404;
                            return;
                        }
                        context.Response.Headers.CacheControl = "no-store";
                        if (Path.GetFileName(file) == "index.html")
                        {
                            context.Response.ContentType = "text/html; charset=utf-8";
                            await context.Response.WriteAsync(
                                PatchPre(await File.ReadAllTextAsync(file, context.RequestAborted)),
                                context.RequestAborted
                            );
                        }
                        else
                            await StaticFile(context, file);
                    }
                )
        );
    }

    private async Task Static(
        HttpContext context,
        string root,
        string? relative,
        bool workbench = false
    )
    {
        var file = AssetFile(root, relative);
        if ((workbench && !Prepared) || file is null || !File.Exists(file))
        {
            context.Response.StatusCode = 404;
            return;
        }
        if (workbench && relative == "out/vs/workbench/workbench.web.main.internal.js")
        {
            context.Response.ContentType = "text/javascript; charset=utf-8";
            context.Response.Headers.CacheControl = "no-store";
            await context.Response.WriteAsync(
                PatchWorkbench(await File.ReadAllTextAsync(file, context.RequestAborted)),
                context.RequestAborted
            );
        }
        else
            await StaticFile(context, file);
    }

    private static Task StaticFile(HttpContext context, string file)
    {
        context.Response.ContentType = Mime.TryGetContentType(file, out var type)
            ? type
            : "application/octet-stream";
        return context.Response.SendFileAsync(file, context.RequestAborted);
    }
}
