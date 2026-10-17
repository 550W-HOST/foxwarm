using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal static class FileDeliveryArtifact
{
    // The shared browser parser accepts only this bounded version-1 value, not arbitrary tool text.
    internal static JsonObject Create(
        string targetKind,
        string targetId,
        string name,
        long size,
        string path,
        string sourceNode,
        string? mimeType = null
    )
    {
        foreach (
            var (value, maximum) in new[]
            {
                (targetId, 512),
                (name, 512),
                (path, 4096),
                (sourceNode, 128),
            }
        )
            if (value.Length == 0 || value.Length > maximum || value.Contains('\0'))
                throw new InvalidDataException(
                    "File delivery metadata exceeds the supported bounds."
                );
        if (
            name.Contains('/')
            || name.Contains('\\')
            || !Path.IsPathFullyQualified(path)
            || size is < 0 or > 9007199254740991L
        )
            throw new InvalidDataException("File delivery metadata is invalid.");
        return new JsonObject
        {
            ["version"] = 1,
            ["deliveryId"] = Guid.NewGuid().ToString(),
            ["targetKind"] = targetKind,
            ["targetId"] = targetId,
            ["fileName"] = name,
            ["mimeType"] = string.IsNullOrEmpty(mimeType) ? Mime(name) : mimeType,
            ["sizeBytes"] = size,
            ["downloadPath"] = path,
            ["downloadNodeId"] = "master",
            ["sourceNodeId"] = sourceNode,
        };
    }

    private static string Mime(string name) =>
        Path.GetExtension(name).ToLowerInvariant() switch
        {
            ".jpg" or ".jpeg" => "image/jpeg",
            ".png" => "image/png",
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            ".bmp" => "image/bmp",
            ".svg" => "image/svg+xml",
            ".pdf" => "application/pdf",
            ".txt" => "text/plain",
            ".md" => "text/markdown",
            ".json" => "application/json",
            ".zip" => "application/zip",
            ".tar" => "application/x-tar",
            ".gz" => "application/gzip",
            _ => "application/octet-stream",
        };
}
