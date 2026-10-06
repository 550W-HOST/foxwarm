using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Foxwarm.Code;

internal static partial class CodeGitService
{
    private const int MaxOutput = 10 * 1024 * 1024;

    internal static async Task<byte[]> RunAsync(
        string workspace,
        string[] args,
        CancellationToken token,
        int limit = MaxOutput,
        bool discover = false
    )
    {
        var start = new ProcessStartInfo("git")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (
            var arg in new[]
            {
                "-c",
                "safe.directory=" + (discover ? "*" : workspace),
                "-C",
                workspace,
            }.Concat(args)
        )
            start.ArgumentList.Add(arg);
        using var process = new Process { StartInfo = start };
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromSeconds(10));
        try
        {
            process.Start();
            var output = CodeFileService.ReadBoundedAsync(
                process.StandardOutput.BaseStream,
                limit,
                deadline.Token
            );
            var errors = DrainErrorAsync(process.StandardError.BaseStream, deadline.Token);
            var exit = process.WaitForExitAsync(deadline.Token);
            var all = Task.WhenAll(output, errors, exit);
            var first = await Task.WhenAny(all, output);
            if (first == output && output.IsFaulted)
                await output;
            await all;
            if (process.ExitCode != 0)
                throw new CodeServiceException(
                    "GitError",
                    Encoding.UTF8.GetString(await errors).Trim() is { Length: > 0 } message
                        ? message
                        : "Git operation failed."
                );
            return await output;
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        {
            throw new CodeServiceException("GitError", "Git operation timed out.");
        }
        catch (System.ComponentModel.Win32Exception error)
        {
            throw new CodeServiceException(
                "Unavailable",
                "Git is unavailable on Main.",
                inner: error
            );
        }
        finally
        {
            try
            {
                if (!process.HasExited)
                    process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException) { }
        }
    }

    private static async Task<byte[]> DrainErrorAsync(Stream input, CancellationToken token)
    {
        using var output = new MemoryStream();
        var buffer = new byte[4096];
        while (true)
        {
            var size = await input.ReadAsync(buffer, token);
            if (size == 0)
                return output.ToArray();
            var keep = (int)Math.Min(size, Math.Max(0, 65536 - output.Length));
            output.Write(buffer, 0, keep);
        }
    }

    private static string Text(byte[] value) => Encoding.UTF8.GetString(value);

    private static async Task<string> TopLevelAsync(string workspace, CancellationToken token) =>
        Text(
                await RunAsync(
                    workspace,
                    ["rev-parse", "--show-toplevel"],
                    token,
                    1024 * 1024,
                    discover: true
                )
            )
            .Trim();

    private static string Kind(string xy, string? old) =>
        xy.Contains('U') ? "conflicted"
        : old is not null || xy.Contains('R') ? "renamed"
        : xy == "??" ? "untracked"
        : xy.Contains('A') ? "added"
        : xy.Contains('D') ? "deleted"
        : xy.IndexOfAny(['M', 'T', 'C']) >= 0 ? "modified"
        : "unknown";

    internal static JsonArray ParseStatus(byte[] raw)
    {
        var rows = Text(raw).Split('\0', StringSplitOptions.RemoveEmptyEntries);
        var changes = new JsonArray();
        for (var i = 0; i < rows.Length; i++)
        {
            var row = rows[i];
            if (row.StartsWith("! "))
                continue;
            if (row.StartsWith("? "))
            {
                changes.Add(
                    new JsonObject
                    {
                        ["path"] = row[2..],
                        ["indexStatus"] = "?",
                        ["workingTreeStatus"] = "?",
                        ["kind"] = "untracked",
                    }
                );
                continue;
            }
            if (!row.StartsWith("1 ") && !row.StartsWith("2 ") && !row.StartsWith("u "))
                continue;
            var fields = row.Split(' ');
            var moved = row[0] == '2';
            var xy = fields.ElementAtOrDefault(1) ?? "..";
            var sub = fields.ElementAtOrDefault(2) ?? "N...";
            var path = string.Join(
                ' ',
                fields.Skip(
                    moved ? 9
                    : row[0] == 'u' ? 10
                    : 8
                )
            );
            if (path.Length == 0)
                continue;
            var old = moved && i + 1 < rows.Length ? rows[++i] : null;
            var change = new JsonObject
            {
                ["path"] = path,
                ["indexStatus"] = xy[0].ToString(),
                ["workingTreeStatus"] = xy[1].ToString(),
                ["kind"] = Kind(xy, old),
            };
            if (old is not null)
                change["oldPath"] = old;
            if (sub.StartsWith('S'))
            {
                change["submoduleState"] = sub;
                change["submodule"] = new JsonObject
                {
                    ["headOid"] = fields.ElementAtOrDefault(6) ?? "",
                    ["indexOid"] = fields.ElementAtOrDefault(7) ?? "",
                    ["dirty"] = sub[2..].IndexOfAny(['M', 'U']) >= 0,
                };
            }
            changes.Add(change);
        }
        return changes;
    }

    internal static async Task<JsonObject> StatusAsync(string workspace, CancellationToken token)
    {
        var top = await TopLevelAsync(workspace, token);
        var changes = ParseStatus(
            await RunAsync(top, ["status", "--porcelain=v2", "-z", "-uall"], token)
        );
        foreach (var change in changes.OfType<JsonObject>())
            if (
                change["submodule"] is JsonObject sub
                && await ReadHeadAsync(Path.Combine(top, change["path"]!.GetValue<string>()), token)
                    is string oid
            )
                sub["worktreeOid"] = oid;
        return new()
        {
            ["nodeId"] = "master",
            ["workspace"] = top,
            ["topLevel"] = top,
            ["changes"] = changes,
        };
    }

    private static async Task<string?> SmallTextAsync(string path, CancellationToken token)
    {
        try
        {
            if (new FileInfo(path).Length > 4 * 1024 * 1024)
                return null;
            return (await File.ReadAllTextAsync(path, token)).Trim();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static async Task<string?> ReadHeadAsync(string worktree, CancellationToken token)
    {
        var git = Path.Combine(worktree, ".git");
        if (!Directory.Exists(git))
        {
            var pointer = await SmallTextAsync(git, token);
            if (
                pointer is null
                || !pointer.StartsWith("gitdir:", StringComparison.OrdinalIgnoreCase)
            )
                return null;
            git = Path.GetFullPath(pointer[7..].Trim(), worktree);
        }
        var head = await SmallTextAsync(Path.Combine(git, "HEAD"), token);
        if (head is null)
            return null;
        if (Regex.IsMatch(head, "^[0-9a-f]{40,64}$", RegexOptions.IgnoreCase))
            return head.ToLowerInvariant();
        if (!head.StartsWith("ref: refs/"))
            return null;
        var reference = head[5..];
        if (reference.Contains("../"))
            return null;
        var loose = await SmallTextAsync(Path.Combine(git, reference), token);
        if (loose is not null && Regex.IsMatch(loose, "^[0-9a-f]{40,64}$", RegexOptions.IgnoreCase))
            return loose.ToLowerInvariant();
        foreach (
            var line in (await SmallTextAsync(Path.Combine(git, "packed-refs"), token) ?? "").Split(
                '\n'
            )
        )
        {
            var pair = line.Split(' ');
            if (
                pair.Length == 2
                && pair[1] == reference
                && Regex.IsMatch(pair[0], "^[0-9a-f]{40,64}$", RegexOptions.IgnoreCase)
            )
                return pair[0].ToLowerInvariant();
        }
        return null;
    }

    internal static string ContentRef(string? value)
    {
        if (string.IsNullOrEmpty(value) || value == "HEAD")
            return "HEAD";
        if (!Regex.IsMatch(value, "^[0-9a-f]{40}([0-9a-f]{24})?$", RegexOptions.IgnoreCase))
            throw new CodeServiceException(
                "InvalidCommit",
                "Git content ref must be HEAD or a full object id."
            );
        return value.ToLowerInvariant();
    }

    internal static string RelativePath(string workspace, string? value)
    {
        if (
            string.IsNullOrWhiteSpace(value)
            || value.Contains('\0')
            || value.Replace('\\', '/').StartsWith('/')
        )
            throw new CodeServiceException(
                "InvalidPath",
                "Path must be relative to the repository."
            );
        var full = Path.GetFullPath(value.Replace('\\', '/'), workspace);
        var relative = Path.GetRelativePath(workspace, full).Replace('\\', '/');
        if (
            relative == "."
            || relative == ".."
            || relative.StartsWith("../")
            || Path.IsPathRooted(relative)
        )
            throw new CodeServiceException("InvalidPath", "Path escapes the workspace.");
        return relative;
    }

    internal static async Task<byte[]> ContentAsync(
        string workspace,
        string? relative,
        string? side,
        string? reference,
        CancellationToken token
    )
    {
        var normalized = RelativePath(workspace, relative);
        var full = Path.Combine(workspace, normalized);
        var chosen = ContentRef(reference);
        if (side is null or "base")
        {
            try
            {
                return await RunAsync(workspace, ["show", chosen + ":" + normalized], token);
            }
            catch (CodeServiceException error) when (error.Code == "GitError")
            {
                return [];
            }
        }
        if (side != "working")
            throw new CodeServiceException("InvalidPath", "side must be base or working.");
        try
        {
            var stat = CodeFileService.StatFile(full);
            if ((stat["type"]!.GetValue<int>() & 1) == 0)
                return [];
            using var file = File.OpenRead(full);
            return await CodeFileService.ReadBoundedAsync(file, MaxOutput, token);
        }
        catch (CodeServiceException error) when (error.Code == "FileNotFound")
        {
            return [];
        }
    }
}
