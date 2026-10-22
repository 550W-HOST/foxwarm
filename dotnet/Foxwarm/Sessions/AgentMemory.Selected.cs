using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class AgentMemory
{
    internal static IReadOnlyList<string>? Selection(JsonObject envelope) =>
        NormalizeSelection(envelope["systemPromptFiles"]);

    internal static IReadOnlyList<string>? NormalizeSelection(JsonNode? value)
    {
        if (value is JsonArray array)
            return array
                .OfType<JsonValue>()
                .Select(item =>
                    item.TryGetValue<string>(out var text) ? SessionGoal.Trim(text) : ""
                )
                .Where(text => text.Length > 0)
                .ToArray();
        if (value is JsonValue scalar && scalar.TryGetValue<string>(out var textValue))
            return textValue
                .Split([',', '\n'])
                .Select(SessionGoal.Trim)
                .Where(text => text.Length > 0 && !text.StartsWith('#'))
                .ToArray();
        return null;
    }

    internal static void NormalizePersistedSelection(JsonObject envelope)
    {
        if (!envelope.ContainsKey("systemPromptFiles"))
            return;
        var selection = Selection(envelope);
        if (selection is null)
            envelope.Remove("systemPromptFiles");
        else
            envelope["systemPromptFiles"] = new JsonArray(
                selection.Select(text => (JsonNode?)JsonValue.Create(text)).ToArray()
            );
    }

    private async Task AppendSelectedAsync(
        StringBuilder blocks,
        string agentName,
        string sessionId,
        string modelId,
        IReadOnlyList<string> selection,
        CancellationToken token
    )
    {
        var agentDirectory = agents.AgentDirectory(agentName);
        var restrictToAgentDirectory = IsolatedToolCompatibility
            .Metadata(agents.MetadataSnapshot()[agentName])
            .Isolated;
        foreach (var reference in selection)
        {
            token.ThrowIfCancellationRequested();
            var expanded =
                reference == "~" ? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)
                : reference.StartsWith("~/", StringComparison.Ordinal)
                || reference.StartsWith("~\\", StringComparison.Ordinal)
                    ? Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                        reference[2..]
                    )
                : reference;
            var path = Path.GetFullPath(expanded, agentDirectory);
            if (
                restrictToAgentDirectory
                && !ToolAuthorizationEvaluation.Within(path, agentDirectory)
            )
                throw new InvalidDataException(
                    $"Isolated agent session can only access agents/{agentName}/ on master."
                );
            if (!RegularSelectedFile(path))
                throw new InvalidDataException(
                    $"systemPromptFiles entry '{reference}' must resolve to an existing ordinary file."
                );
            var (visible, body) = FilterFrontMatter(
                await File.ReadAllTextAsync(path, token),
                sessionId
            );
            if (visible)
                AppendBlock(
                    blocks,
                    agentName,
                    "self",
                    path,
                    ConditionalMemory.FilterConditionalMemorySource(body, modelId)
                );
        }
    }

    private static bool RegularSelectedFile(string path)
    {
        if (!File.Exists(path))
            return false;
        if (!OperatingSystem.IsLinux())
        {
            var target = new FileInfo(path).ResolveLinkTarget(true)?.FullName ?? path;
            return (File.GetAttributes(target) & (FileAttributes.Directory | FileAttributes.Device))
                == 0;
        }
        return SelectedStatx(-100, path, 0, 1, out var info) == 0 && (info.Mode & 0xf000) == 0x8000;
    }

    [StructLayout(LayoutKind.Explicit, Size = 256)]
    private struct SelectedFileType
    {
        [FieldOffset(28)]
        internal ushort Mode;
    }

    [DllImport("libc", EntryPoint = "statx", SetLastError = true)]
    private static extern int SelectedStatx(
        int directory,
        string path,
        int flags,
        uint mask,
        out SelectedFileType info
    );
}
