using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Foxwarm.Code;

internal static partial class CodeGitService
{
    internal static async Task<JsonObject> CommitAsync(
        string workspace,
        string? id,
        CancellationToken token
    )
    {
        if (id is null || !Regex.IsMatch(id, "^[0-9a-f]{7,64}$", RegexOptions.IgnoreCase))
            throw new CodeServiceException(
                "InvalidCommit",
                "Commit id must contain 7 to 64 hexadecimal characters."
            );
        var top = await TopLevelAsync(workspace, token);
        if (
            Text(await RunAsync(top, ["cat-file", "-t", id], token, 1024 * 1024)).Trim() != "commit"
        )
            throw new CodeServiceException(
                "InvalidCommit",
                "The supplied object id does not name a commit directly."
            );
        var oid = Text(await RunAsync(top, ["rev-parse", "--verify", id], token, 1024 * 1024))
            .Trim()
            .ToLowerInvariant();
        if (!Regex.IsMatch(oid, "^[0-9a-f]{40}([0-9a-f]{24})?$"))
            throw new CodeServiceException(
                "InvalidCommit",
                "Git resolved an invalid commit object id."
            );
        var metadata = Text(
                await RunAsync(
                    top,
                    [
                        "show",
                        "-s",
                        "--no-show-signature",
                        "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s%x00%B",
                        oid,
                    ],
                    token,
                    2 * 1024 * 1024
                )
            )
            .Split('\0');
        if (metadata.Length < 8 || metadata[0].Trim().ToLowerInvariant() != oid)
            throw new CodeServiceException(
                "InvalidCommit",
                "Git returned invalid commit metadata."
            );
        var parents = metadata[1]
            .Trim()
            .ToLowerInvariant()
            .Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var parent = parents.FirstOrDefault();
        var comparison = parent is null ? new[] { oid } : new[] { parent, oid };
        var root = parent is null ? new[] { "--root" } : [];
        var raw = await RunAsync(
            top,
            new[] { "diff-tree" }
                .Concat(root)
                .Concat(["--no-commit-id", "-r", "-z", "--raw", "--full-index", "-M"])
                .Concat(comparison)
                .Append("--")
                .ToArray(),
            token,
            20 * 1024 * 1024
        );
        var numstat = await RunAsync(
            top,
            new[] { "diff-tree" }
                .Concat(root)
                .Concat(["--no-commit-id", "-r", "-z", "--numstat", "-M"])
                .Concat(comparison)
                .Append("--")
                .ToArray(),
            token,
            20 * 1024 * 1024
        );
        var files = ParseCommitRaw(raw);
        var stats = ParseCommitNumstat(numstat);
        long additions = 0,
            deletions = 0;
        var binaries = 0;
        foreach (var file in files.OfType<JsonObject>())
            if (stats.TryGetValue(file["path"]!.GetValue<string>(), out var stat))
            {
                file["binary"] = stat.Binary;
                if (stat.Binary)
                    binaries++;
                else
                {
                    file["additions"] = stat.Additions;
                    file["deletions"] = stat.Deletions;
                    additions += stat.Additions;
                    deletions += stat.Deletions;
                }
            }
        return new()
        {
            ["nodeId"] = "master",
            ["workspace"] = top,
            ["commit"] = new JsonObject
            {
                ["oid"] = oid,
                ["parents"] = new JsonArray(
                    parents.Select(p => (JsonNode?)JsonValue.Create(p)).ToArray()
                ),
                ["author"] = new JsonObject { ["name"] = metadata[2], ["email"] = metadata[3] },
                ["authoredAt"] = metadata[4],
                ["committedAt"] = metadata[5],
                ["subject"] = metadata[6],
                ["message"] = string.Join('\0', metadata.Skip(7)).TrimEndOneNewline(),
            },
            ["comparison"] = new JsonObject
            {
                ["parentOid"] = parent,
                ["mode"] = parent is null ? "empty-tree" : "first-parent",
            },
            ["stats"] = new JsonObject
            {
                ["files"] = files.Count,
                ["additions"] = additions,
                ["deletions"] = deletions,
                ["binaryFiles"] = binaries,
            },
            ["files"] = files,
        };
    }

    private static string TrimEndOneNewline(this string value) =>
        value.EndsWith('\n') ? value[..^1] : value;

    internal static JsonArray ParseCommitRaw(byte[] raw)
    {
        var rows = Text(raw).Split('\0');
        var files = new JsonArray();
        for (var i = 0; i < rows.Length; )
        {
            var header = rows[i++];
            if (header.Length == 0)
                continue;
            var match = Regex.Match(
                header,
                "^:(\\d{6}) (\\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([A-Z])(\\d*)$",
                RegexOptions.IgnoreCase
            );
            if (!match.Success || i >= rows.Length)
                throw new CodeServiceException(
                    "InvalidCommit",
                    "Git returned an invalid raw commit diff record."
                );
            var status = match.Groups[5].Value.ToUpperInvariant();
            var first = rows[i++];
            var moved = status is "R" or "C";
            if (moved && i >= rows.Length)
                throw new CodeServiceException(
                    "InvalidCommit",
                    "Git rename/copy record is incomplete."
                );
            var last = moved ? rows[i++] : first;
            var file = new JsonObject
            {
                ["status"] = status,
                ["kind"] = status switch
                {
                    "A" => "added",
                    "M" => "modified",
                    "D" => "deleted",
                    "R" => "renamed",
                    "C" => "copied",
                    "T" => "type-changed",
                    _ => "unknown",
                },
                ["path"] = last,
                ["oldOid"] = match.Groups[3].Value.ToLowerInvariant(),
                ["newOid"] = match.Groups[4].Value.ToLowerInvariant(),
                ["oldMode"] = match.Groups[1].Value,
                ["newMode"] = match.Groups[2].Value,
                ["binary"] = false,
                ["submodule"] =
                    match.Groups[1].Value == "160000" || match.Groups[2].Value == "160000",
            };
            if (moved)
                file["oldPath"] = first;
            files.Add(file);
            if (files.Count > 5000)
                throw new CodeServiceException(
                    "PayloadTooLarge",
                    "Commit changes more than 5000 files."
                );
        }
        return files;
    }

    private sealed record Numstat(long Additions, long Deletions, bool Binary);

    private static Dictionary<string, Numstat> ParseCommitNumstat(byte[] raw)
    {
        var rows = Text(raw).Split('\0');
        var stats = new Dictionary<string, Numstat>(StringComparer.Ordinal);
        for (var i = 0; i < rows.Length; )
        {
            var row = rows[i++];
            if (row.Length == 0)
                continue;
            var fields = row.Split('\t', 3);
            if (fields.Length != 3)
                throw new CodeServiceException(
                    "InvalidCommit",
                    "Git returned an invalid numstat record."
                );
            var path = fields[2];
            if (path.Length == 0)
            {
                if (i + 1 >= rows.Length)
                    throw new CodeServiceException(
                        "InvalidCommit",
                        "Git numstat rename record is incomplete."
                    );
                i++;
                path = rows[i++];
            }
            var binary = fields[0] == "-" || fields[1] == "-";
            if (!binary && (!long.TryParse(fields[0], out _) || !long.TryParse(fields[1], out _)))
                throw new CodeServiceException(
                    "InvalidCommit",
                    "Git returned invalid line counts."
                );
            stats[path] = binary
                ? new(0, 0, true)
                : new(long.Parse(fields[0]), long.Parse(fields[1]), false);
        }
        return stats;
    }
}
