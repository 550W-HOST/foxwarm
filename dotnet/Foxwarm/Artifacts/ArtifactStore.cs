using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Artifacts;

/// <summary>Source-compatible immutable revisions, owned by exact Session identity.</summary>
internal sealed class ArtifactStore(string root, ArtifactPreparer? preparer = null)
{
    internal const int ManifestLimit = 2 * 1024 * 1024;
    internal const int ImageLimit = 12 * 1024 * 1024;
    private readonly ArtifactPreparer prepare = preparer ?? new();
    private readonly object gate = new();
    private readonly Dictionary<string, Task> pending = new(StringComparer.Ordinal);

    private static bool Matches(string? text, string expression) =>
        text is not null && Regex.IsMatch(text, expression, RegexOptions.CultureInvariant);

    private string RevisionFile(string id, long revision)
    {
        if (!Matches(id, @"^art_[a-f0-9]{32}$") || revision < 1 || revision > 9007199254740991)
            throw new InvalidDataException("Invalid artifact reference");
        return Path.Combine(root, id, revision + ".json");
    }

    internal static bool ValidReceipt(JsonNode? value) =>
        value is JsonObject receipt
        && SessionWait.Number(receipt["protocolVersion"]) == 1
        && Matches(SessionWait.Text(receipt["artifactId"]), @"^art_[a-f0-9]{32}$")
        && SessionWait.Number(receipt["revision"]) is double revision
        && revision >= 1
        && revision <= 9007199254740991
        && Math.Truncate(revision) == revision
        && SessionWait.Text(receipt["sessionId"]) is { Length: > 0 and <= 256 }
        && Matches(SessionWait.Text(receipt["type"]), @"^[a-z][a-z0-9-]{0,39}$")
        && SessionWait.Text(receipt["title"]) is { Length: > 0 and <= 160 } title
        && SessionGoal.Trim(title).Length > 0;

    internal async Task<JsonObject> ReadAsync(
        string id,
        long revision,
        string sessionId,
        CancellationToken token = default
    )
    {
        var record =
            JsonNode
                .Parse(await File.ReadAllTextAsync(RevisionFile(id, revision), token))
                ?.AsObject()
            ?? throw new InvalidDataException("Artifact unavailable");
        var receipt = record["receipt"];
        if (
            !ValidReceipt(receipt)
            || SessionWait.Text(receipt!["sessionId"]) != sessionId
            || SessionWait.Text(receipt["artifactId"]) != id
            || SessionWait.Number(receipt["revision"]) != revision
        )
            throw new InvalidDataException("Artifact unavailable");
        return record;
    }

    internal async Task<(byte[] Bytes, string MimeType)> ResourceAsync(
        string id,
        long revision,
        string sessionId,
        string name,
        CancellationToken token = default
    )
    {
        if (!Matches(name, @"^[a-z][a-z0-9_-]{0,63}$"))
            throw new InvalidDataException("Resource unavailable");
        var record = await ReadAsync(id, revision, sessionId, token);
        var descriptor = record["resources"]?[name];
        var digest = SessionWait.Text(descriptor?["sha256"]);
        if (!Matches(digest, @"^[a-f0-9]{64}$"))
            throw new InvalidDataException("Resource unavailable");
        var bytes = await File.ReadAllBytesAsync(
            Path.Combine(root, id, "resources", digest!),
            token
        );
        if (
            SessionWait.Number(descriptor?["sizeBytes"]) != bytes.Length
            || Convert.ToHexStringLower(SHA256.HashData(bytes)) != digest
        )
            throw new InvalidDataException("Resource unavailable");
        return (bytes, SessionWait.Text(descriptor?["mimeType"]) ?? "");
    }

    private long Latest(string id) =>
        Directory
            .EnumerateFiles(Path.Combine(root, id))
            .Select(Path.GetFileName)
            .Where(name => Matches(name, @"^\d+\.json$"))
            .Select(name =>
                long.Parse(name![..^5], System.Globalization.CultureInfo.InvariantCulture)
            )
            .Max();

    internal async Task<long> LatestRevisionAsync(
        string id,
        string sessionId,
        CancellationToken token = default
    )
    {
        await ReadAsync(id, 1, sessionId, token);
        return Latest(id);
    }

    internal async Task<JsonObject> PublishAsync(
        string sessionId,
        JsonObject value,
        string? artifactId = null,
        long? expectedRevision = null,
        byte[]? image = null,
        CancellationToken token = default
    )
    {
        var document = await prepare.ValidateAsync(value, token);
        var id =
            artifactId ?? "art_" + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
        _ = RevisionFile(id, 1);
        Task<JsonObject> job;
        lock (gate)
        {
            pending.TryGetValue(id, out var previous);
            job = PublishAfter(previous ?? Task.CompletedTask);
            pending[id] = job;
        }
        try
        {
            return await job;
        }
        finally
        {
            lock (gate)
            {
                if (pending.TryGetValue(id, out var current) && current == job)
                    pending.Remove(id);
            }
        }

        async Task<JsonObject> PublishAfter(Task previous)
        {
            try
            {
                await previous;
            }
            catch
            { /* A failed publication does not poison the next revision. */
            }
            long revision = 1;
            if (artifactId is not null)
            {
                if (expectedRevision is null or < 1)
                    throw new InvalidDataException("Updating requires expectedRevision");
                var old = await ReadAsync(id, expectedRevision.Value, sessionId, token);
                if (SessionWait.Text(old["receipt"]?["type"]) != SessionWait.Text(document["type"]))
                    throw new InvalidDataException("An artifact cannot change type");
                var latest = Latest(id);
                if (latest != expectedRevision)
                    throw new InvalidDataException(
                        "Revision conflict: inspect the latest publication before updating"
                    );
                revision = latest + 1;
            }
            else if (expectedRevision is not null)
                throw new InvalidDataException("expectedRevision requires artifactId");
            var record = new JsonObject
            {
                ["receipt"] = new JsonObject
                {
                    ["protocolVersion"] = 1,
                    ["artifactId"] = id,
                    ["revision"] = revision,
                    ["sessionId"] = sessionId,
                    ["type"] = document["type"]?.DeepClone(),
                    ["title"] = document["title"]?.DeepClone(),
                },
                ["document"] = document.DeepClone(),
                ["createdAt"] = DateTime.UtcNow.ToString(
                    "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
                    System.Globalization.CultureInfo.InvariantCulture
                ),
            };
            if (SessionWait.Text(document["type"]) == "react")
                record["compiled"] = await prepare.CompileAsync(document, token);
            byte[]? resource = null;
            string? digest = null;
            if (SessionWait.Text(document["type"]) == "image")
            {
                if (image is null)
                    throw new InvalidDataException(
                        "Image publication requires a raster file, using type: image"
                    );
                resource = image.ToArray();
                var actual = await prepare.ImageAsync(
                    resource,
                    SessionWait.Text(document["title"])!,
                    document["alt"],
                    token
                );
                if (
                    new[] { "mimeType", "width", "height" }.Any(key =>
                        !JsonNode.DeepEquals(actual[key], document[key])
                    )
                )
                    throw new InvalidDataException("Image metadata does not match its bytes");
                digest = Convert.ToHexStringLower(SHA256.HashData(resource));
                record["resources"] = new JsonObject
                {
                    ["image"] = new JsonObject
                    {
                        ["mimeType"] = document["mimeType"]?.DeepClone(),
                        ["sizeBytes"] = resource.Length,
                        ["sha256"] = digest,
                    },
                };
            }
            var target = RevisionFile(id, revision);
            CreatePrivateDirectory(Path.GetDirectoryName(target)!);
            if (resource is not null)
            {
                var directory = Path.Combine(root, id, "resources");
                CreatePrivateDirectory(directory);
                await PublishFile(
                    Path.Combine(directory, digest!),
                    resource,
                    allowExisting: true,
                    token
                );
            }
            // Resources are complete before the exclusively-created revision becomes visible.
            await PublishFile(
                target,
                System.Text.Encoding.UTF8.GetBytes(record.ToJsonString()),
                allowExisting: false,
                token
            );
            return record;
        }
    }

    private static void CreatePrivateDirectory(string path)
    {
        if (OperatingSystem.IsWindows())
            Directory.CreateDirectory(path);
        else
            Directory.CreateDirectory(
                path,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            );
    }

    private static async Task PublishFile(
        string target,
        byte[] bytes,
        bool allowExisting,
        CancellationToken token
    )
    {
        var temporary =
            target + "." + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8)) + ".tmp";
        try
        {
            var options = new FileStreamOptions
            {
                Mode = FileMode.CreateNew,
                Access = FileAccess.Write,
                Share = FileShare.None,
                Options = FileOptions.Asynchronous,
            };
            if (!OperatingSystem.IsWindows())
                options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            await using (var stream = new FileStream(temporary, options))
                await stream.WriteAsync(bytes, token);
            try
            {
                File.Move(temporary, target);
            }
            catch (IOException) when (allowExisting && File.Exists(target)) { }
        }
        finally
        {
            File.Delete(temporary);
        }
    }
}
