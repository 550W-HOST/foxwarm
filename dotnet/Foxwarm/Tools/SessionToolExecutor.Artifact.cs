using System.Text.Json.Nodes;
using Foxwarm.Artifacts;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal sealed partial class SessionToolExecutor
{
    private WorkspaceTools ArtifactFiles(string node) =>
        sessions.IdentityWorkspace(
            hosted,
            node == ExecutionNode ? ExecutionCwd : null,
            "master",
            useLiveCwd: false
        );

    private static long? ArtifactRevision(JsonObject args, string key)
    {
        if (!args.ContainsKey(key))
            return null;
        if (
            SessionWait.Number(args[key]) is not double number
            || number < 1
            || number > 9007199254740991
            || Math.Truncate(number) != number
        )
            throw new InvalidDataException(key + " must be a positive safe integer");
        return (long)number;
    }

    private static string ArtifactMarker(JsonNode receipt) =>
        $"<foxwarm-artifact id=\"{SessionWait.Text(receipt["artifactId"])}\" revision=\"{receipt["revision"]}\" />";

    private async Task<JsonObject> ExecuteArtifactAsync(JsonObject args, CancellationToken token)
    {
        if (ToolRegistry.Text(args, "action") == "get")
        {
            ToolRegistry.Keys(args, ["action", "artifactId", "revision"]);
            var id =
                ToolRegistry.Text(args, "artifactId")
                ?? throw new InvalidDataException("Invalid artifact reference");
            var revision =
                ArtifactRevision(args, "revision")
                ?? await sessions.Artifacts.LatestRevisionAsync(id, hosted.Id, token);
            var record = await sessions.Artifacts.ReadAsync(id, revision, hosted.Id, token);
            var metadata = record["receipt"]!.DeepClone().AsObject();
            metadata["createdAt"] = record["createdAt"]?.DeepClone();
            return new JsonObject
            {
                ["output"] = metadata.ToJsonString(),
                ["marker"] = ArtifactMarker(record["receipt"]!),
            };
        }
        if (!ToolRegistry.ArtifactFileSource(args))
            throw new InvalidDataException("Supported actions: prepare, publish, get");
        ToolRegistry.Keys(
            args,
            ["action", "filePath", "node", "artifactId", "expectedRevision", "type", "title", "alt"]
        );
        var file = ToolRegistry.Text(args, "filePath");
        if (file is not { Length: > 0 and <= 4096 })
            throw new InvalidDataException("A bounded filePath is required");
        var type = ToolRegistry.Text(args, "type");
        if (args.ContainsKey("type") && type != "image")
            throw new InvalidDataException(
                "type is only needed for raster image files; other types come from the manifest"
            );
        if (type != "image" && (args.ContainsKey("title") || args.ContainsKey("alt")))
            throw new InvalidDataException("title and alt apply only to raster image files");
        var node = ToolRegistry.ArtifactSourceNode(args, ExecutionNode);
        var cwd = node == ExecutionNode ? ExecutionCwd : null;
        var files = ArtifactFiles(node);
        var limit = type == "image" ? ArtifactStore.ImageLimit : ArtifactStore.ManifestLimit;
        await sessions.AuthorizeToolAsync(
            hosted,
            new(
                "artifact",
                "node",
                "read",
                new JsonObject { ["filePath"] = file },
                ExecutionNode: node
            ),
            files,
            token,
            toolScriptSourceRead: true
        );
        byte[] bytes;
        if (node == "master")
        {
            var actual = AuthorizationPaths.CanonicalPotential(files.Paths.FilePath(file));
            sessions.RequireMainFileSourcePath(hosted, actual);
            if (!WorkspaceTools.RegularFile(actual))
                throw new InvalidDataException("Artifact source must be a regular file");
            await using var stream = new FileStream(
                actual,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete,
                65536,
                FileOptions.Asynchronous
            );
            if (!WorkspaceTools.RegularFileHandle(stream, actual) || stream.Length > limit)
                throw new InvalidDataException(
                    "Artifact source must be a regular file of at most "
                        + limit / 1024 / 1024
                        + " MiB"
                );
            bytes = new byte[limit + 1];
            var size = 0;
            int count;
            while (
                size < bytes.Length
                && (count = await stream.ReadAsync(bytes.AsMemory(size), token)) != 0
            )
                size += count;
            Array.Resize(ref bytes, size);
        }
        else if (sessions.NodeProviders.IsProviderNode(node))
            bytes = await sessions.NodeProviders.ReadSourceAsync(
                node,
                file,
                cwd,
                token,
                limit: limit,
                boundRequests: true
            );
        else
            bytes = (await ReadResidentSourceAsync(node, file, cwd, files, token)).Bytes;
        if (bytes.Length > limit)
            throw new InvalidDataException($"Artifact exceeds {limit / 1024 / 1024} MiB");
        JsonObject document;
        if (type == "image")
        {
            var title = args.ContainsKey("title")
                ? ToolRegistry.Text(args, "title") ?? ""
                : file.Split(['/', '\\']).Last();
            if (!args.ContainsKey("title") && title.Length > 160)
                title = title[..160];
            document = await sessions.ArtifactPreparation.ImageAsync(
                bytes,
                title,
                args["alt"],
                token
            );
        }
        else
            document =
                JsonNode.Parse(System.Text.Encoding.UTF8.GetString(bytes))?.AsObject()
                ?? throw new InvalidDataException("Artifact must be an object");
        var stored = await sessions.Artifacts.PublishAsync(
            hosted.Id,
            document,
            ToolRegistry.Text(args, "artifactId"),
            ArtifactRevision(args, "expectedRevision"),
            type == "image" ? bytes : null,
            token
        );
        var receipt = stored["receipt"]!;
        var result = new JsonObject { ["marker"] = ArtifactMarker(receipt) };
        if (SessionWait.Text(args["action"]) == "prepare")
        {
            result["output"] =
                $"Prepared {SessionWait.Text(receipt["type"])}: {SessionWait.Text(receipt["title"])}. Place the marker on its own line between blank lines in assistant prose to display it.";
            result["preparedArtifact"] = receipt.DeepClone();
        }
        else
        {
            result["output"] =
                $"Published {SessionWait.Text(receipt["type"])}: {SessionWait.Text(receipt["title"])} (revision {receipt["revision"]}).";
            result["artifact"] = receipt.DeepClone();
        }
        return result;
    }

    // Reuse the resident approved read and correlated complete-file transfer, not display text.
    private async Task<Foxwarm.Nodes.NodeConnectionHub.TransferFile> ReadResidentSourceAsync(
        string node,
        string file,
        string? cwd,
        WorkspaceTools files,
        CancellationToken token,
        Action<long>? beforeMaterialize = null
    )
    {
        string? resolvedPath = null;
        await sessions.Nodes.ExecuteAsync(
            node,
            "read",
            new JsonObject { ["filePath"] = file },
            hosted.Id,
            hosted.Agent,
            node,
            cwd,
            true,
            token,
            hosted,
            value =>
            {
                resolvedPath = SessionWait.Text(value?["filePath"]);
                if (
                    resolvedPath is null
                    && value?["__foxwarmResolvedToolPaths"] is JsonArray paths
                    && paths.Count == 1
                    && SessionWait.Text(paths[0]?["raw"]) == file
                )
                    resolvedPath = SessionWait.Text(paths[0]?["resolved"]);
            }
        );
        return await sessions.ReadNodeFileAsync(
            hosted,
            node,
            resolvedPath ?? RemoteSourcePath(file, cwd),
            files,
            token,
            beforeMaterialize
        );
    }
}
