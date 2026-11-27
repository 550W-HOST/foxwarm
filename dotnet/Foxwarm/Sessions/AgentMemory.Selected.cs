using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;

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
        string runtime,
        IReadOnlyList<string> selection,
        CancellationToken token
    )
    {
        foreach (var reference in selection)
        {
            token.ThrowIfCancellationRequested();
            if (!agents.PhysicalFolders)
            {
                await AppendStoredSelectionAsync(blocks, agentName, sessionId, modelId, runtime, reference, token);
                continue;
            }
            var path = ResolveSelectedPath(agentName, reference);
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
                    ConditionalMemory.FilterConditionalMemorySource(body, modelId, runtime, masterNode)
                );
        }
    }

    // A selected file in the Agent store: a reference inside the Agent's folder, read and shown
    // by its folder-relative path, with the folder's checks.
    private async Task AppendStoredSelectionAsync(
        StringBuilder blocks,
        string agentName,
        string sessionId,
        string modelId,
        string runtime,
        string reference,
        CancellationToken token
    )
    {
        var path = SelectedStorePath(reference);
        if (files.Stat(agentName, path) is not { IsDirectory: false })
            throw new InvalidDataException(
                $"systemPromptFiles entry '{reference}' must resolve to an existing ordinary file."
            );
        var (visible, body) = FilterFrontMatter(await files.ReadTextAsync(agentName, path, token), sessionId);
        if (visible)
            AppendBlock(
                blocks,
                agentName,
                "self",
                path,
                ConditionalMemory.FilterConditionalMemorySource(body, modelId, runtime, masterNode)
            );
    }

    /// <summary>
    /// The store path of a selected file without Agent folders: folder-relative or
    /// <c>$fw_agentdir/</c> references; anything outside the folder is refused.
    /// </summary>
    internal static string SelectedStorePath(string reference)
    {
        string relative;
        try
        {
            relative = Foxwarm.Tools.AgentFolderPaths.Relative(reference);
        }
        catch (InvalidDataException)
        {
            throw new InvalidDataException(
                $"`{reference}` is outside this Agent's folder, so it can't be a prompt file here."
            );
        }
        if (relative.Length == 0 || AgentFilePaths.Problem(relative) is not null)
            throw new InvalidDataException(
                $"systemPromptFiles entry '{reference}' must resolve to an existing ordinary file."
            );
        return relative;
    }

    internal string ResolveSelectedPath(string agentName, string reference)
    {
        var expanded =
            reference == "~" ? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)
            : reference.StartsWith("~/", StringComparison.Ordinal)
            || reference.StartsWith("~\\", StringComparison.Ordinal)
                ? Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                    reference[2..]
                )
            : reference;
        return Path.GetFullPath(expanded, agents.AgentDirectory(agentName));
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
