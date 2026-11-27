using System.Text.Json.Nodes;
using Foxwarm.Models;
using YamlDotNet.Core;
using YamlDotNet.Core.Events;
using YamlDotNet.RepresentationModel;

namespace Foxwarm.Hosted.Import;

/// <summary>A cut block of <c>config.yaml</c>: its key path and 1-based line range.</summary>
internal sealed record ConfigBlock(string Key, int FirstLine, int LastLine, string Part);

/// <summary>The two documents a file-mode <c>config.yaml</c> becomes, and what neither keeps.</summary>
internal sealed record ConfigSplitResult(
    string TenantText,
    string DeploymentText,
    JsonObject Tenant,
    JsonObject Deployment,
    IReadOnlyList<ConfigBlock> Blocks,
    IReadOnlyList<(string Key, JsonNode? Value)> Dropped
);

/// <summary>
/// Splits a file-mode <c>config.yaml</c> into the tenant <c>config</c> document and a draft
/// deployment configuration by cutting whole YAML blocks by line range: top-level blocks, and
/// the children of <c>bot</c>, which mixes tenant and deployment settings. Every other line,
/// comments included, stays in the tenant document unchanged. Settings hosted mode refuses
/// (<see cref="AppConfigurationSplit.UnavailablePaths"/>) and paths that are neither deployment
/// nor hosted tenant paths (<see cref="AppConfigurationSplit.TenantPaths"/>) are cut into
/// neither and returned with their values. Both parts are parsed back: their merge must equal the original without the
/// dropped settings, and each must pass its own document's rules, or the split is refused.
/// The draft gets <paramref name="blobsBlock"/> (the backend the import wrote the blobs to)
/// unless the source already had a <c>blobs</c> block.
/// </summary>
internal static class ConfigSplit
{
    private const string Bot = "bot";

    internal static ConfigSplitResult Split(string text, string sourceName = "config.yaml", string? blobsBlock = null)
    {
        var bom = text.StartsWith('\uFEFF') ? "\uFEFF" : "";
        var body = text[bom.Length..];
        var lines = body.Split('\n');
        var original = Parse(body, sourceName);
        YamlMappingNode? root;
        try
        {
            var stream = new YamlStream();
            stream.Load(new StringReader(body));
            root = stream.Documents.Count == 0 ? null : stream.Documents[0].RootNode as YamlMappingNode;
        }
        catch (YamlException error)
        {
            throw new ImportRefusedException(
                $"{sourceName} isn't valid YAML at line {error.Start.Line}: fix it in file mode first."
            );
        }
        var cut = new List<(ConfigBlock Block, int Start, int End)>();
        var keep = new bool[lines.Length];
        Array.Fill(keep, true);
        if (root is not null)
        {
            var entries = root.Children.Select(pair => (Name: Scalar(pair.Key), Key: pair.Key, Value: pair.Value)).ToList();
            var needsCut = entries.Any(entry =>
                Classify(entry.Name) is not "tenant"
                || entry.Name == Bot && entry.Value is YamlMappingNode bot && bot.Children.Any(child => Classify(Bot + "." + Scalar(child.Key)) is not "tenant")
            );
            if (needsCut && root.Style == MappingStyle.Flow)
                throw new ImportRefusedException(
                    $"{sourceName} is a flow mapping (or JSON), which can't be split by lines: rewrite it as block YAML first."
                );
            // The empty string after a final newline belongs to no block, so the tenant text
            // keeps its final newline whichever block is cut.
            var lastLine = lines.Length - 1 - (lines.Length > 1 && lines[^1].Length == 0 ? 1 : 0);
            var ranges = Ranges(lines, entries.Select(entry => (int)entry.Key.Start.Line - 1).ToList(), lastLine, 0);
            for (var index = 0; index < entries.Count; index++)
            {
                var (name, _, value) = entries[index];
                var (start, end) = ranges[index];
                var part = Classify(name);
                if (part is not "tenant")
                {
                    cut.Add((new ConfigBlock(name, start + 1, end + 1, part), start, end));
                    for (var line = start; line <= end; line++)
                        keep[line] = false;
                    continue;
                }
                if (name != Bot || value is not YamlMappingNode botMap || botMap.Children.Count == 0)
                    continue;
                var children = botMap.Children.Select(pair => (Name: Bot + "." + Scalar(pair.Key), Key: pair.Key)).ToList();
                if (children.All(child => Classify(child.Name) is "tenant"))
                    continue;
                if (botMap.Style == MappingStyle.Flow)
                    throw new ImportRefusedException(
                        $"{sourceName} writes `bot` as a flow mapping, which can't be split by lines: rewrite it as a block mapping first."
                    );
                var childRanges = Ranges(lines, children.Select(child => (int)child.Key.Start.Line - 1).ToList(), end, start + 1);
                var header = (start, Math.Max(start, childRanges[0].Start - 1));
                var kept = 0;
                for (var child = 0; child < children.Count; child++)
                {
                    var childPart = Classify(children[child].Name);
                    var (childStart, childEnd) = childRanges[child];
                    if (childPart is "tenant")
                    {
                        kept++;
                        continue;
                    }
                    cut.Add((new ConfigBlock(children[child].Name, childStart + 1, childEnd + 1, childPart), childStart, childEnd));
                    for (var line = childStart; line <= childEnd; line++)
                        keep[line] = false;
                }
                // A bot mapping left without children would read as `bot: null`, a deployment
                // path in the tenant document, so its header line goes too.
                if (kept == 0)
                    for (var line = header.Item1; line <= header.Item2; line++)
                        keep[line] = false;
            }
        }
        var tenantText = bom + string.Join('\n', lines.Where((_, index) => keep[index]));
        var deploymentLines = new List<string>
        {
            "# Deployment configuration drafted by `foxwarm hosted import` from " + sourceName + ".",
            "# Review it, set the required settings below, and mount it as FOXWARM_DEPLOYMENT_CONFIG.",
        };
        var botChildren = cut.Where(item => item.Block.Part == "deployment" && item.Block.Key.StartsWith(Bot + ".", StringComparison.Ordinal)).ToList();
        foreach (var item in cut.Where(item => item.Block.Part == "deployment" && !item.Block.Key.StartsWith(Bot + ".", StringComparison.Ordinal)))
            deploymentLines.AddRange(TrimTrailingBlank(lines[item.Start..(item.End + 1)]));
        if (botChildren.Count > 0)
        {
            deploymentLines.Add(Bot + ":");
            foreach (var item in botChildren)
                deploymentLines.AddRange(TrimTrailingBlank(lines[item.Start..(item.End + 1)]));
        }
        if (!cut.Any(item => item.Block.Key == "health"))
            deploymentLines.AddRange(["# Required: the health port the orchestrator probes.", "# health:", "#   port: 8081"]);
        if (!cut.Any(item => item.Block.Key == "blobs"))
            deploymentLines.AddRange(
                blobsBlock is null
                    ? ["# Required: where blobs are stored, `s3` or `postgres`.", "# blobs:", "#   backend: postgres"]
                    : ["# Where the import wrote the blobs; replicas must read them from the same place.", .. blobsBlock.TrimEnd('\n').Split('\n')]
            );
        var deploymentText = string.Join('\n', deploymentLines) + "\n";

        var dropped = cut.Where(item => item.Block.Part == "dropped")
            .Select(item => (item.Block.Key, Value(original, item.Block.Key)))
            .ToList();
        var tenant = Parse(tenantText.TrimStart('\uFEFF'), "the tenant part of " + sourceName);
        var deployment = Parse(deploymentText, "the deployment part of " + sourceName);
        var expected = (JsonObject)original.DeepClone();
        foreach (var (key, _) in dropped)
            Remove(expected, key);
        if (expected[Bot] is JsonObject { Count: 0 } && tenant[Bot] is null && deployment[Bot] is null)
            expected.Remove(Bot);
        try
        {
            AppConfigurationSplit.RequireHostedChannels(tenant);
        }
        catch (InvalidDataException error)
        {
            throw new ImportRefusedException($"{sourceName}: {error.Message}");
        }
        try
        {
            AppConfigurationSplit.RequireTenantDocument(tenant);
            AppConfigurationSplit.RequireDeploymentDocument(deployment);
        }
        catch (InvalidDataException error)
        {
            throw new ImportRefusedException($"{sourceName} can't be split by whole blocks ({error.Message}); split it by hand.");
        }
        var cutDeployment = (JsonObject)deployment.DeepClone();
        if (!cut.Any(item => item.Block.Key == "blobs"))
            cutDeployment.Remove("blobs");
        if (!ImportJson.SameIgnoringOrder(AppConfigurationSplit.Merge(cutDeployment, tenant), expected))
            throw new ImportRefusedException(
                $"{sourceName} can't be split by whole blocks: the parsed parts don't add up to the original (an anchor or alias may cross a cut block). Split it by hand."
            );
        return new ConfigSplitResult(tenantText, deploymentText, tenant, deployment, cut.Select(item => item.Block).ToList(), dropped);
    }

    /// <summary>"tenant", "deployment" or "dropped" for a top-level key or a <c>bot.child</c> path.</summary>
    internal static string Classify(string path)
    {
        if (AppConfigurationSplit.UnavailablePaths.Contains(path))
            return "dropped";
        if (path == Bot)
            return "tenant";
        if (path == "journal" || AppConfigurationSplit.DeploymentPaths.Contains(path))
            return "deployment";
        // What a hosted tenant's document may hold; anything else is reported, not kept.
        return AppConfigurationSplit.TenantPaths(TenantProfile.Hosted).Contains(path) ? "tenant" : "dropped";
    }

    // The line range of each key: from its line, or from the comment lines directly above it at
    // its own indentation, to the line before the next key's range. The last range ends at
    // `last`. Lines before the first key belong to none.
    private static List<(int Start, int End)> Ranges(string[] lines, List<int> keyLines, int last, int floor)
    {
        var starts = new List<int>();
        for (var index = 0; index < keyLines.Count; index++)
        {
            var start = keyLines[index];
            var indent = Indent(lines[start]);
            var limit = index == 0 ? floor : keyLines[index - 1] + 1;
            while (start - 1 >= limit && IsComment(lines[start - 1]) && Indent(lines[start - 1]) == indent)
                start--;
            starts.Add(start);
        }
        var ranges = new List<(int, int)>();
        for (var index = 0; index < starts.Count; index++)
            ranges.Add((starts[index], index + 1 < starts.Count ? starts[index + 1] - 1 : last));
        return ranges;
    }

    private static bool IsComment(string line) => line.TrimStart().StartsWith('#');

    private static int Indent(string line) => line.Length - line.TrimStart(' ').Length;

    private static IEnumerable<string> TrimTrailingBlank(string[] block)
    {
        var count = block.Length;
        while (count > 0 && block[count - 1].Trim().Length == 0)
            count--;
        return block[..count];
    }

    private static string Scalar(YamlNode node) =>
        node is YamlScalarNode scalar
            ? scalar.Value ?? "null"
            : throw new ImportRefusedException("config.yaml has a non-scalar mapping key.");

    private static JsonObject Parse(string text, string label)
    {
        try
        {
            return ConfigurationYaml.Parse(text, label);
        }
        catch (InvalidDataException error)
        {
            throw new ImportRefusedException($"config.yaml can't be split by whole blocks: {error.Message} Split it by hand.");
        }
    }

    private static JsonNode? Value(JsonObject document, string path)
    {
        var parts = path.Split('.', 2);
        var value = document[parts[0]];
        return (parts.Length == 2 ? (value as JsonObject)?[parts[1]] : value)?.DeepClone();
    }

    private static void Remove(JsonObject document, string path)
    {
        var parts = path.Split('.', 2);
        if (parts.Length == 1)
            document.Remove(path);
        else if (document[parts[0]] is JsonObject section)
            section.Remove(parts[1]);
    }
}
