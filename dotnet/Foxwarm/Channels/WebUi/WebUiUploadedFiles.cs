using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Images;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Channels.WebUi;

internal sealed record PreparedUploadedParts(
    IReadOnlyList<JsonObject> Parts,
    IReadOnlyList<JsonObject> SavedFiles
);

internal sealed class UploadPreparationException(
    string message,
    Exception cause,
    IReadOnlyList<JsonObject> saved
) : IOException(message, cause)
{
    internal IReadOnlyList<JsonObject> SavedFiles { get; } = saved;
    internal bool InvalidInput =>
        InnerException is ImageInputException or InvalidDataException or ArgumentException;
}

internal sealed class WebUiUploadedFiles(SessionManager sessions)
{
    internal const long Limit = 50L * 1024 * 1024;
    internal string Root => Path.Combine(sessions.DataRoot, "state", "webui-uploads");
    internal Func<SessionOwner, string, Task>? BeforeStage { get; set; }

    internal static string Mime(string? declared, string filename)
    {
        var raw = SessionGoal.Trim(declared ?? "");
        var mime = raw.ToLowerInvariant();
        if (mime.StartsWith("image/", StringComparison.Ordinal))
            return mime;
        if (mime is not ("" or "application/octet-stream"))
            return raw;
        return ChannelFileNames.Extension(filename).ToLowerInvariant() switch
        {
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            ".heic" => "image/heic",
            ".heif" => "image/heif",
            ".bmp" => "image/bmp",
            ".svg" => "image/svg+xml",
            _ => "application/octet-stream",
        };
    }

    internal async Task<PreparedUploadedParts> PrepareAsync(
        JsonObject input,
        SessionOwner? owner,
        CancellationToken token,
        WebUiRequest? scoped = null
    )
    {
        var parts =
            input["parts"] is JsonArray given
                ? given.OfType<JsonObject>().Select(part => (JsonObject)part.DeepClone()).ToList()
            : SessionWait.Text(input["text"]) is { } text ? [new JsonObject { ["text"] = text }]
            : [];
        if (
            input["parts"] is JsonArray array
            && (
                parts.Count != array.Count
                || parts.Any(part => part.Count != 1 || SessionWait.Text(part["text"]) is null)
            )
        )
            throw new ImageInputException(
                "Message parts must contain text; attach files through upload."
            );
        var saved = new List<JsonObject>();
        var entries = input["uploadedFiles"] as JsonArray ?? input["filePaths"] as JsonArray ?? [];
        try
        {
            foreach (var entry in entries)
            {
                if (owner is null)
                    throw new ImageInputException("Attachment Session is unavailable.");
                var path =
                    SessionWait.Text(entry)
                    ?? SessionWait.Text((entry as JsonObject)?["path"])
                    ?? throw new ImageInputException("Uploaded file has no staging path.");
                scoped?.RequireUpload(owner.Id, path);
                var suppliedName = SessionWait.Text((entry as JsonObject)?["filename"]);
                var filename = !string.IsNullOrEmpty(SessionGoal.Trim(suppliedName ?? ""))
                    ? SessionGoal.Trim(suppliedName!)
                    : Path.GetFileName(path);
                var mime = Mime(SessionWait.Text((entry as JsonObject)?["mimeType"]), filename);
                var bytes = await ReadStagedAsync(path, token);
                await StageAsync(owner, "before-copy");
                await sessions.WaitForIdentityMutationAsync(owner.Id, token);
                sessions.RequireFileIngressOwner(owner);
                scoped?.RequireUpload(owner.Id, path);
                var node = sessions.FileIngressNode(owner);
                var timestamp = DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH-mm-ss-fffZ");
                var storage = ChannelFileNames.StorageName(
                    filename,
                    mime,
                    timestamp,
                    Convert.ToHexStringLower(
                        System.Security.Cryptography.RandomNumberGenerator.GetBytes(4)
                    )
                );
                string destination;
                if (node != "master")
                {
                    // Authenticated administrator ingress selects the real owner; it is not a model tool call.
                    var relative = ".temp/channel-files/webui/" + storage;
                    var written = await sessions.Nodes.WriteFileAsync(
                        node,
                        relative,
                        bytes,
                        false,
                        owner,
                        true,
                        token
                    );
                    destination =
                        SessionWait.Text(written["absolutePath"])
                        ?? SessionWait.Text(written["filePath"])
                        ?? relative;
                    saved.Add(
                        new JsonObject
                        {
                            ["path"] = destination,
                            ["filename"] = filename,
                            ["node"] = node,
                            ["mimeType"] = mime,
                            ["size"] = bytes.Length,
                        }
                    );
                }
                else
                {
                    var directory = Path.Combine(
                        sessions.AgentDirectory(owner.Agent),
                        ".temp",
                        "channel-files",
                        "webui"
                    );
                    destination = Path.Combine(directory, storage);
                    Directory.CreateDirectory(directory);
                    token.ThrowIfCancellationRequested();
                    // Keep the actual started destination across move; delete only this created temporary file.
                    var temp =
                        destination
                        + "."
                        + Environment.ProcessId
                        + "."
                        + Guid.NewGuid().ToString("N")
                        + ".tmp";
                    var created = false;
                    try
                    {
                        scoped?.Require(owner.Id);
                        await using (
                            var output = new FileStream(
                                temp,
                                FileMode.CreateNew,
                                FileAccess.Write,
                                FileShare.None,
                                65536,
                                FileOptions.Asynchronous
                            )
                        )
                        {
                            created = true;
                            await output.WriteAsync(bytes, token);
                            await output.FlushAsync(token);
                            output.Flush(true);
                        }
                        scoped?.Require(owner.Id);
                        File.Move(temp, destination, overwrite: false);
                        created = false;
                        saved.Add(
                            new JsonObject
                            {
                                ["path"] = destination,
                                ["filename"] = filename,
                                ["node"] = "master",
                                ["mimeType"] = mime,
                                ["size"] = bytes.Length,
                            }
                        );
                        LinuxAtomicJsonFile.LinuxDirectorySync.Sync(directory);
                    }
                    finally
                    {
                        if (created)
                            File.Delete(temp);
                    }
                }
                await StageAsync(owner, "after-copy");
                scoped?.Require(owner.Id);
                parts.Add(
                    new JsonObject
                    {
                        ["text"] = ChannelFileNames.Descriptor(filename, destination, mime, node),
                    }
                );
                if (mime.StartsWith("image/", StringComparison.Ordinal))
                {
                    var imageId = "image_" + Guid.NewGuid();
                    var reference = await sessions.Images.PutAsync(bytes, mime, imageId, token);
                    parts.Add(
                        new JsonObject
                        {
                            ["inlineDataRef"] = reference,
                            ["imageMeta"] = new JsonObject
                            {
                                ["imageId"] = imageId,
                                ["mimeType"] = mime,
                                ["width"] = reference["width"]?.DeepClone(),
                                ["height"] = reference["height"]?.DeepClone(),
                                ["sizeBytes"] = bytes.Length,
                                ["sha256"] = reference["sha256"]?.DeepClone(),
                            },
                        }
                    );
                }
                scoped?.ConsumeUpload(path);
                // Administrator callers may still use other existing staging files.
                File.Delete(path);
            }
            return new(parts, saved);
        }
        catch (Exception error)
        {
            throw new UploadPreparationException(
                "Attachment preparation failed. "
                    + (
                        saved.Count > 0
                            ? $"{saved.Count} file(s) were saved and were not removed. "
                            : ""
                    )
                    + error.Message,
                error,
                saved
            );
        }
    }

    private async Task<byte[]> ReadStagedAsync(string path, CancellationToken token)
    {
        var root = AuthorizationPaths.CanonicalPotential(Root);
        var physical = AuthorizationPaths.CanonicalPotential(Path.GetFullPath(path));
        if (
            !physical.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal)
            || !WorkspaceTools.RegularFile(path)
        )
            throw new ImageInputException(
                "Uploaded file is not a regular file in server upload staging."
            );
        await using var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            65536,
            FileOptions.Asynchronous
        );
        if (!WorkspaceTools.RegularFileHandle(stream, path))
            throw new ImageInputException("Uploaded file is not a regular file.");
        if (OperatingSystem.IsLinux())
        {
            var opened = new FileInfo(
                "/proc/self/fd/" + stream.SafeFileHandle.DangerousGetHandle().ToInt64()
            )
                .ResolveLinkTarget(true)
                ?.FullName;
            if (
                opened is null
                || !opened.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal)
            )
                throw new ImageInputException("Uploaded file is outside server upload staging.");
        }
        if (stream.Length > Limit)
            throw new ImageInputException("File exceeds the 50 MiB upload limit.");
        using var buffer = new MemoryStream();
        var chunk = new byte[65536];
        int read;
        while ((read = await stream.ReadAsync(chunk, token)) > 0)
        {
            if (buffer.Length + read > Limit)
                throw new ImageInputException("File exceeds the 50 MiB upload limit.");
            buffer.Write(chunk, 0, read);
        }
        return buffer.ToArray();
    }

    private async Task StageAsync(SessionOwner owner, string stage)
    {
        if (BeforeStage is { } callback)
            await callback(owner, stage);
        var marker = Path.Combine(
            sessions.DataRoot,
            "state",
            "experiment-faults",
            SessionIdentity.ExecDirectorySegment(owner.Id) + ".upload-" + stage + "-hold"
        );
        if (!File.Exists(marker))
            return;
        await File.WriteAllTextAsync(marker + ".reached", "reached");
        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (File.Exists(marker) && DateTime.UtcNow < deadline)
            await Task.Delay(2);
        if (File.Exists(marker))
            throw new IOException("Experimental attachment barrier expired.");
    }
}
