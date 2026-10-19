using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace Foxwarm.CliNode;

internal sealed class NodeFileTransfer(NodePaths paths)
{
    internal async Task<JsonObject> Read(string raw, string agent, bool restrict)
    {
        var path = paths.Transfer(raw, agent, restrict);
        if (Directory.Exists(path))
            throw new InvalidDataException("Not a file: " + raw);
        var bytes = await File.ReadAllBytesAsync(path);
        var (mime, image) = Mime(raw);
        return new JsonObject
        {
            ["filePath"] = raw,
            ["name"] = Path.GetFileName(raw),
            ["sizeBytes"] = bytes.LongLength,
            ["mimeType"] = mime,
            ["isImage"] = image,
            ["sha256"] = Convert.ToHexStringLower(SHA256.HashData(bytes)),
            ["dataBase64"] = Convert.ToBase64String(bytes),
        };
    }

    internal async Task<JsonObject> Write(
        string raw,
        string agent,
        string data,
        bool overwrite,
        bool restrict
    )
    {
        var path = paths.Transfer(raw, agent, restrict);
        var existed = NodeFileTools.Exists(path);
        var existsMessage = $"File already exists: {raw}. Use overwrite=true to replace it.";
        if (existed && !overwrite)
            throw new InvalidDataException(existsMessage);
        var bytes = DecodeBase64(data);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary =
            path
            + "."
            + Environment.ProcessId
            + "."
            + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(6))
            + ".tmp";
        try
        {
            await using (
                var stream = new FileStream(
                    temporary,
                    FileMode.CreateNew,
                    FileAccess.Write,
                    FileShare.None
                )
            )
                await stream.WriteAsync(bytes);
            // Same-directory rename replaces a final symlink, unlike ordinary content writes.
            File.Move(temporary, path, overwrite);
        }
        finally
        {
            File.Delete(temporary);
        }
        return new JsonObject
        {
            ["filePath"] = raw,
            ["absolutePath"] = path,
            ["sizeBytes"] = bytes.LongLength,
            ["sha256"] = Convert.ToHexStringLower(SHA256.HashData(bytes)),
            ["overwritten"] = existed,
        };
    }

    // Node Buffer's base64 input accepts the URL alphabet, missing padding and ignored nonalphabet bytes.
    private static byte[] DecodeBase64(string text)
    {
        var clean = new System.Text.StringBuilder();
        foreach (var ch in text)
        {
            if (ch == '=')
                break;
            if (ch is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9' or '+' or '/')
                clean.Append(ch);
            else if (ch is '-' or '_')
                clean.Append(ch == '-' ? '+' : '/');
        }
        if (clean.Length % 4 == 1)
            clean.Length--;
        while (clean.Length % 4 != 0)
            clean.Append('=');
        return Convert.FromBase64String(clean.ToString());
    }

    private static (string Mime, bool Image) Mime(string path) =>
        Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".png" => ("image/png", true),
            ".jpg" or ".jpeg" => ("image/jpeg", true),
            ".gif" => ("image/gif", true),
            ".webp" => ("image/webp", true),
            ".bmp" => ("image/bmp", true),
            ".svg" => ("image/svg+xml", true),
            ".json" => ("application/json", false),
            ".txt" or ".ts" or ".js" or ".sh" => ("text/plain", false),
            ".md" => ("text/markdown", false),
            ".yaml" or ".yml" => ("application/yaml", false),
            _ => ("application/octet-stream", false),
        };
}
