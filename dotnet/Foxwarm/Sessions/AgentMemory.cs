using System.Collections;
using System.Text;
using System.Text.RegularExpressions;
using Foxwarm;
using Foxwarm.Models;
using YamlDotNet.Serialization;

namespace Foxwarm.Sessions;

internal sealed partial class AgentMemory(
    AgentCatalog agents,
    Skills skills,
    string? frameworkTemplatePath = null,
    HostModels? models = null,
    Action<string>? warning = null
)
{
    public async Task<string> BuildAsync(
        string agentName,
        string sessionId,
        string concreteModelId,
        CancellationToken cancellationToken = default,
        IReadOnlyList<string>? selection = null,
        bool externalRuntime = false
    )
    {
        var blocks = new StringBuilder();
        var runtime = externalRuntime ? ClaudeRuntimeState.Kind : ConditionalMemory.FoxwarmRuntime;
        if (selection is not null)
            await AppendSelectedAsync(
                blocks,
                agentName,
                sessionId,
                concreteModelId,
                runtime,
                selection,
                cancellationToken
            );
        else
        {
            // A legacy copy still present at startup was edited and keeps replacing the bundled base.
            var replacement =
                File.Exists(agents.FrameworkSystemPath) ? agents.FrameworkSystemPath
                : File.Exists(agents.MainFallbackSystemPath) ? agents.MainFallbackSystemPath
                : null;
            var frameworkPath =
                replacement ?? (File.Exists(frameworkTemplatePath) ? frameworkTemplatePath : null);
            if (frameworkPath is not null)
                AppendBlock(
                    blocks,
                    frameworkPath == agents.MainFallbackSystemPath ? "main" : "framework",
                    frameworkPath != agents.MainFallbackSystemPath || agentName != "main"
                        ? "inherited"
                        : "self",
                    frameworkPath,
                    ConditionalMemory.FilterConditionalMemorySource(
                        await File.ReadAllTextAsync(frameworkPath, cancellationToken),
                        concreteModelId,
                        runtime
                    )
                );
            if (File.Exists(agents.FrameworkLocalPath))
                AppendBlock(
                    blocks,
                    "framework",
                    "inherited",
                    agents.FrameworkLocalPath,
                    ConditionalMemory.FilterConditionalMemorySource(
                        await File.ReadAllTextAsync(agents.FrameworkLocalPath, cancellationToken),
                        concreteModelId,
                        runtime
                    )
                );

            foreach (var sourceAgent in agents.InheritanceChain(agentName))
            {
                var memoryDir = Path.Combine(agents.SourceDirectory(sourceAgent), "memory");
                if (Directory.Exists(memoryDir))
                    foreach (
                        var path in Directory
                            .EnumerateFiles(memoryDir, "*.md", SearchOption.TopDirectoryOnly)
                            .OrderBy(path => Path.GetFileName(path), StringComparer.Ordinal)
                    )
                    {
                        var fileName = Path.GetFileName(path);
                        if (
                            fileName == FrameworkPrompt.FileName
                            || fileName.Equals("ONBOOT.md", StringComparison.OrdinalIgnoreCase)
                        )
                            continue;
                        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                            throw new InvalidDataException(
                                "Agent memory file cannot be a symbolic link."
                            );
                        var (visible, body) = FilterFrontMatter(
                            await File.ReadAllTextAsync(path, cancellationToken),
                            sessionId
                        );
                        if (visible)
                            AppendBlock(
                                blocks,
                                sourceAgent,
                                sourceAgent == agentName ? "self" : "inherited",
                                path,
                                ConditionalMemory.FilterConditionalMemorySource(
                                    body,
                                    concreteModelId,
                                    runtime
                                )
                            );
                    }
            }
        }
        var catalog = await skills.ListAsync(agentName);
        cancellationToken.ThrowIfCancellationRequested();
        if (catalog.Count > 0)
        {
            blocks.Append(
                "\n\nThe following skills provide specialized instructions for specific tasks.\nWhen a task matches a skill's description, call skill with action=\"load\"\nand the skill's name to load its full instructions and resource list.\nRead listed resources only when the loaded skill or current task needs them:\n<available_skills>\n"
            );
            foreach (var skill in catalog)
                blocks
                    .Append("  <skill><name>")
                    .Append(Xml(skill.Name))
                    .Append("</name><description>")
                    .Append(Xml(skill.Description ?? ""))
                    .Append("</description><source>")
                    .Append(skill.SourceType)
                    .Append("</source></skill>\n");
            blocks.Append("</available_skills>\n");
        }
        AppendModelCatalog(blocks, concreteModelId);
        var directory = $"--- DIRECTORIES ---\n- agent_folder: {agents.AgentDirectory(agentName)}";
        var bodyText = blocks.ToString().Trim();
        if (externalRuntime)
            return bodyText.Length == 0 ? directory : bodyText + "\n\n" + directory;
        var snapshot = ConditionalMemory.BuildCurrentModelSnapshot(
            concreteModelId,
            bodyText.Length == 0 ? directory : bodyText + "\n\n" + directory
        );
        var size = MemorySize.Measure(snapshot, models?.Capture());
        if (!size.OverThreshold)
            return snapshot;
        (warning ?? Console.Error.WriteLine)(
            $"Memory warning: Agent={agentName} Session={sessionId} bytes={size.Bytes} estimatedTokens={size.EstimatedTokens} contextPercent={MemorySize.Percent(size.ContextFraction!.Value)} thresholdPercent={MemorySize.Percent(size.ThresholdFraction)}"
        );
        return snapshot + "\n\n" + size.Notice();
    }

    private void AppendModelCatalog(StringBuilder blocks, string concreteModelId)
    {
        var configured = models?.Capture();
        if (configured is null || configured.Catalog.Count == 0)
            return;
        blocks.Append(
            "\n\nThe user recommends these models for new Sessions. When a task fits one's description, pass its key in the `model` parameter of `create_child_session` or `create_session`:\n<available_models>\n"
        );
        foreach (var entry in configured.Catalog)
        {
            var current = configured
                .ReachableLeaves(entry.Key)
                .Any(leaf => leaf.Key == concreteModelId);
            blocks.Append(current ? "  <model current=\"true\"><key>" : "  <model><key>");
            blocks
                .Append(Xml(entry.Key))
                .Append("</key><description>")
                .Append(Xml(entry.Description))
                .Append("</description>");
            if (configured.SharedPrice(entry.Key) is { } price)
                blocks
                    .Append("<price cached=\"")
                    .Append(HostModels.FormatRate(price.Cached))
                    .Append("\" input=\"")
                    .Append(HostModels.FormatRate(price.Input))
                    .Append("\" output=\"")
                    .Append(HostModels.FormatRate(price.Output))
                    .Append("\" unit=\"USD per 1M tokens\"/>");
            blocks.Append("</model>\n");
        }
        blocks.Append("</available_models>\n");
    }

    private static string Xml(string value) =>
        value
            .Replace("&", "&amp;", StringComparison.Ordinal)
            .Replace("<", "&lt;", StringComparison.Ordinal)
            .Replace(">", "&gt;", StringComparison.Ordinal);

    private static void AppendBlock(
        StringBuilder output,
        string agent,
        string ownership,
        string path,
        string body
    ) =>
        output
            .Append("\n<memory_file agent=")
            .Append(agent)
            .Append("; ownership=")
            .Append(ownership)
            .Append("; path=")
            .Append(path)
            .Append(">\n")
            .Append(body)
            .Append("\n</memory_file>");

    private static (bool Visible, string Body) FilterFrontMatter(string content, string sessionId)
    {
        var match = FrontMatter().Match(content);
        if (!match.Success)
            return (true, content);
        var body = content[match.Length..];
        object? parsed;
        try
        {
            parsed = new DeserializerBuilder().Build().Deserialize<object>(match.Groups[1].Value);
        }
        catch (YamlDotNet.Core.YamlException)
        {
            return (true, body);
        }
        if (parsed is not IDictionary metadata)
            return (true, body);
        var include = Patterns(metadata["include-session"]);
        var exclude = Patterns(metadata["exclude-session"]);
        if (exclude is not null && exclude.Any(pattern => Matches(pattern, sessionId)))
            return (false, body);
        if (include is not null && !include.Any(pattern => Matches(pattern, sessionId)))
            return (false, body);
        return (true, body);
    }

    private static string[]? Patterns(object? raw)
    {
        if (raw is null)
            return null;
        if (raw is string one)
            return one.Trim().Length == 0 ? [] : [one.Trim()];
        if (raw is not IList list)
            return null;
        var patterns = new List<string>();
        foreach (var entry in list)
        {
            if (entry is not string text)
                return null;
            if (text.Trim().Length > 0)
                patterns.Add(text.Trim());
        }
        return [.. patterns];
    }

    private static bool Matches(string pattern, string sessionId)
    {
        var expression = new StringBuilder("^");
        for (var index = 0; index < pattern.Length; index++)
        {
            var current = pattern[index];
            if (current == '*')
            {
                if (index + 1 < pattern.Length && pattern[index + 1] == '*')
                {
                    while (index + 1 < pattern.Length && pattern[index + 1] == '*')
                        index++;
                    expression.Append(".*");
                }
                else
                    expression.Append("[^/]*");
            }
            else if (current == '?')
                expression.Append("[^/]");
            else
                expression.Append(Regex.Escape(current.ToString()));
        }
        return Regex.IsMatch(
            sessionId,
            expression.Append('$').ToString(),
            RegexOptions.CultureInvariant
        );
    }

    [GeneratedRegex(
        "^---[ \\t]*(?:\\r?\\n)([\\s\\S]*?)(?:\\r?\\n)---[ \\t]*(?:\\r?\\n|$)",
        RegexOptions.CultureInvariant
    )]
    private static partial Regex FrontMatter();
}
