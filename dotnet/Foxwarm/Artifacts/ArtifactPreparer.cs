using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Artifacts;

/// <summary>The shared validators and compiler are data-only children, not Session hosts.</summary>
internal sealed class ArtifactPreparer
{
    private static int activeCompilers;
    private readonly string entry;

    internal ArtifactPreparer(string? entry = null) =>
        this.entry =
            entry
            ?? Path.Combine(
                AppContext.BaseDirectory,
                "packages",
                "shared",
                "dist",
                "artifacts",
                "managedPrepare.js"
            );

    internal async Task<JsonObject> ValidateAsync(JsonObject document, CancellationToken token) =>
        (
            await Request(
                new JsonObject { ["action"] = "validate", ["document"] = document.DeepClone() },
                token
            )
        )["document"]!.AsObject();

    internal async Task<JsonObject> ImageAsync(
        byte[] bytes,
        string title,
        JsonNode? alt,
        CancellationToken token
    ) =>
        (
            await Request(
                new JsonObject
                {
                    ["action"] = "image",
                    ["bytes"] = Convert.ToBase64String(bytes),
                    ["title"] = title,
                    ["alt"] = alt?.DeepClone(),
                },
                token
            )
        )["document"]!.AsObject();

    internal async Task<string> CompileAsync(JsonObject document, CancellationToken token)
    {
        if (Interlocked.Increment(ref activeCompilers) > 2)
        {
            Interlocked.Decrement(ref activeCompilers);
            throw new InvalidDataException("React compiler is busy. Retry publication shortly.");
        }
        try
        {
            var result = await Request(
                new JsonObject { ["action"] = "react", ["document"] = document.DeepClone() },
                token
            );
            var compiled = SessionWait.Text(result["compiled"]);
            if (compiled is null || Encoding.UTF8.GetByteCount(compiled) > 3 * 1024 * 1024)
                throw new InvalidDataException("Invalid compiler response");
            return compiled;
        }
        finally
        {
            Interlocked.Decrement(ref activeCompilers);
        }
    }

    private async Task<JsonObject> Request(JsonObject request, CancellationToken token)
    {
        using var bound = CancellationTokenSource.CreateLinkedTokenSource(token);
        bound.CancelAfter(TimeSpan.FromSeconds(15));
        var info = new ProcessStartInfo("node")
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        info.ArgumentList.Add("--max-old-space-size=128");
        info.ArgumentList.Add(entry);
        // A deployment must use its collected resolver/native closure, not ambient Node paths.
        info.Environment.Remove("NODE_PATH");
        info.Environment.Remove("NODE_OPTIONS");
        info.Environment.Remove("ESBUILD_BINARY_PATH");
        using var child =
            Process.Start(info) ?? throw new IOException("Could not start artifact preparation");
        try
        {
            var output = ReadBounded(
                child.StandardOutput.BaseStream,
                20 * 1024 * 1024,
                bound.Token
            );
            var errors = ReadBounded(child.StandardError.BaseStream, 16384, bound.Token);
            await child.StandardInput.WriteAsync(request.ToJsonString().AsMemory(), bound.Token);
            child.StandardInput.Close();
            var bytes = await output;
            var stderr = await errors;
            await child.WaitForExitAsync(bound.Token);
            var result =
                JsonNode.Parse(bytes)?.AsObject()
                ?? throw new InvalidDataException("Invalid artifact preparation response");
            if (SessionWait.Text(result["error"]) is string error)
                throw new InvalidDataException(error);
            if (child.ExitCode != 0)
                throw new InvalidDataException(
                    "Artifact preparation failed: " + Encoding.UTF8.GetString(stderr)
                );
            return result;
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        {
            throw new TimeoutException("Artifact preparation exceeded 15 seconds");
        }
        finally
        {
            if (!child.HasExited)
                child.Kill(entireProcessTree: true);
            await child.WaitForExitAsync();
        }
    }

    private static async Task<byte[]> ReadBounded(Stream stream, int limit, CancellationToken token)
    {
        using var output = new MemoryStream();
        var buffer = new byte[65536];
        int count;
        while (
            (
                count = await stream.ReadAsync(
                    buffer.AsMemory(0, (int)Math.Min(buffer.Length, limit + 1L - output.Length)),
                    token
                )
            ) > 0
        )
        {
            output.Write(buffer, 0, count);
            if (output.Length > limit)
                throw new InvalidDataException("Artifact preparation output exceeds its bound");
        }
        return output.ToArray();
    }
}
