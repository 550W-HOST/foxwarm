using System.Collections;
using System.Text;
using System.Text.RegularExpressions;
using Foxwarm;
using Foxwarm.Models;

namespace Foxwarm.Sessions;

internal sealed partial class AgentMemory(
    AgentCatalog agents,
    Skills skills,
    string? frameworkTemplatePath = null,
    HostModels? models = null,
    Action<string>? warning = null,
    // What the catalog may show of each skill for (Agent, Session), evaluated once per build;
    // null, or a null result, lists every skill as it is.
    Func<string, string, Func<SkillInfo, SkillAccess>?>? skillAccess = null,
    IAgentFileStore? files = null,
    // RuntimeCapabilities.MasterNode. Without master, the prompt names no Main-local paths: memory
    // blocks have no path and there is no agent_folder line.
    bool masterNode = true
)
{
    private readonly IAgentFileStore files = files ?? new FileAgentFiles(agents);

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
            const string mainCopy = "memory/" + FrameworkPrompt.FileName;
            var (replacementAgent, replacement) =
                files.FileExists(null, FrameworkPrompt.FileName)
                    ? ((string?)null, (string?)FrameworkPrompt.FileName)
                : files.FileExists("main", mainCopy) ? ("main", mainCopy)
                : (null, null);
            if (replacement is not null)
                AppendBlock(
                    blocks,
                    replacementAgent ?? "framework",
                    replacementAgent is null || agentName != "main" ? "inherited" : "self",
                    files.Locator(replacementAgent, replacement),
                    ConditionalMemory.FilterConditionalMemorySource(
                        await files.ReadTextAsync(replacementAgent, replacement, cancellationToken),
                        concreteModelId,
                        runtime,
                        masterNode
                    )
                );
            else if (File.Exists(frameworkTemplatePath))
                // The bundled base is a program resource, not Agent state.
                AppendBlock(
                    blocks,
                    "framework",
                    "inherited",
                    frameworkTemplatePath,
                    ConditionalMemory.FilterConditionalMemorySource(
                        await File.ReadAllTextAsync(frameworkTemplatePath, cancellationToken),
                        concreteModelId,
                        runtime,
                        masterNode
                    )
                );
            if (files.FileExists(null, FrameworkPrompt.LocalFileName))
                AppendBlock(
                    blocks,
                    "framework",
                    "inherited",
                    files.Locator(null, FrameworkPrompt.LocalFileName),
                    ConditionalMemory.FilterConditionalMemorySource(
                        await files.ReadTextAsync(
                            null,
                            FrameworkPrompt.LocalFileName,
                            cancellationToken
                        ),
                        concreteModelId,
                        runtime,
                        masterNode
                    )
                );

            foreach (var sourceAgent in agents.InheritanceChain(agentName))
            {
                foreach (
                    var entry in files
                        .List(sourceAgent, "memory", "*.md")
                        .OrderBy(item => item.Name, StringComparer.Ordinal)
                )
                {
                    var fileName = entry.Name;
                    var path = entry.Locator;
                    if (
                        fileName == FrameworkPrompt.FileName
                        || fileName.Equals("ONBOOT.md", StringComparison.OrdinalIgnoreCase)
                    )
                        continue;
                    if (entry.IsLink)
                        throw new InvalidDataException(
                            "Agent memory file cannot be a symbolic link."
                        );
                    var (visible, body) = FilterFrontMatter(
                        await files.ReadTextAsync(
                            sourceAgent,
                            "memory/" + fileName,
                            cancellationToken
                        ),
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
                                runtime,
                                masterNode
                            )
                        );
                }
            }
        }
        var listed = await skills.ListAsync(agentName);
        cancellationToken.ThrowIfCancellationRequested();
        var access = listed.Count > 0 ? skillAccess?.Invoke(agentName, sessionId) : null;
        var catalog = listed
            .Select(skill => (Skill: skill, Access: access?.Invoke(skill) ?? SkillAccess.Run))
            .Where(entry => entry.Access != SkillAccess.Hidden)
            .Select(entry =>
                entry.Access == SkillAccess.Run || entry.Skill.Run is null
                    ? entry.Skill
                    : entry.Skill with { Run = null }
            )
            .ToArray();
        if (catalog.Length > 0)
        {
            blocks.Append(
                "\n\nThe following skills provide specialized instructions for specific tasks.\nWhen a task matches a skill's description, run `ctl skill load <name>`\nto load its full instructions and resource list.\n"
            );
            // Only a catalog that lists a runnable skill gains the sentence and <run>/<args> elements;
            // any other catalog keeps its bytes (D-request-prefix-stability).
            if (catalog.Any(skill => skill.Run is not null))
                blocks.Append(RunnableSkillsSentence).Append('\n');
            blocks.Append(
                "Read listed resources only when the loaded skill or current task needs them:\n<available_skills>\n"
            );
            foreach (var skill in catalog)
            {
                blocks
                    .Append("  <skill><name>")
                    .Append(Xml(skill.Name))
                    .Append("</name><description>")
                    .Append(Xml(skill.Description ?? ""))
                    .Append("</description><source>")
                    .Append(skill.SourceType)
                    .Append("</source>");
                if (skill.Run is { } run)
                {
                    blocks.Append("<run>").Append(Xml(run.Effect)).Append("</run>");
                    if (run.ArgsText is { } args)
                        blocks.Append("<args>").Append(Xml(args)).Append("</args>");
                }
                blocks.Append("</skill>\n");
            }
            blocks.Append("</available_skills>\n");
        }
        var directory = masterNode
            ? $"--- DIRECTORIES ---\n- agent_folder: {agents.AgentDirectory(agentName)}"
            : "";
        var bodyText = blocks.ToString().Trim();
        var composed =
            directory.Length == 0 ? bodyText
            : bodyText.Length == 0 ? directory
            : bodyText + "\n\n" + directory;
        if (externalRuntime)
            return composed;
        var snapshot = ConditionalMemory.BuildCurrentModelSnapshot(concreteModelId, composed);
        var size = MemorySize.Measure(snapshot, models?.Capture());
        if (!size.OverThreshold)
            return snapshot;
        (warning ?? Console.Error.WriteLine)(
            $"Memory warning: Agent={agentName} Session={sessionId} bytes={size.Bytes} estimatedTokens={size.EstimatedTokens} contextPercent={MemorySize.Percent(size.ContextFraction!.Value)} thresholdPercent={MemorySize.Percent(size.ThresholdFraction)}"
        );
        return snapshot + "\n\n" + size.Notice();
    }

    internal const string RunnableSkillsSentence =
        "A skill with a `<run>` element can also be run directly, without loading it, with `ctl skill run <name> --args @args` and the arguments object in `values.args`. `<run>` says what running it does; `<args>` is the JSON Schema of its arguments, and a skill without `<args>` takes none.";

    private static string Xml(string value) =>
        value
            .Replace("&", "&amp;", StringComparison.Ordinal)
            .Replace("<", "&lt;", StringComparison.Ordinal)
            .Replace(">", "&gt;", StringComparison.Ordinal);

    private void AppendBlock(
        StringBuilder output,
        string agent,
        string ownership,
        string path,
        string body
    )
    {
        output.Append("\n<memory_file agent=").Append(agent).Append("; ownership=").Append(ownership);
        if (masterNode)
            output.Append("; path=").Append(path);
        output.Append(">\n").Append(body).Append("\n</memory_file>");
    }

    private static (bool Visible, string Body) FilterFrontMatter(string content, string sessionId)
    {
        var match = FrontMatter().Match(content);
        if (!match.Success)
            return (true, content);
        var body = content[match.Length..];
        object? parsed;
        try
        {
            parsed = FrontMatterYaml.Parse(match.Groups[1].Value);
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
