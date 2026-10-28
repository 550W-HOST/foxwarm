using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

// One dedicated planner artifact. File effects use the same Node/path policy as ordinary tools.
internal sealed class CompactPlanRepairFile : IAsyncDisposable
{
    private readonly CompactPlanFiles files;
    private readonly SessionOwner owner;
    private string content;

    private CompactPlanRepairFile(
        CompactPlanFiles files,
        SessionOwner owner,
        string path,
        string content,
        bool structuredFallback
    )
    {
        this.files = files;
        this.owner = owner;
        this.content = content;
        FilePath = path;
        StructuredFallback = structuredFallback;
    }

    internal string FilePath { get; }
    internal string Node => files.Node;
    internal string? Cwd => files.Cwd;
    internal bool StructuredFallback { get; }

    internal string Preview()
    {
        const int limit = 1000;
        return content.Length <= limit * 2
            ? content
            : content[..limit] + "\n…\n" + content[^limit..];
    }

    internal static async Task<CompactPlanRepairFile> CreateAsync(
        JsonObject call,
        SessionManager sessions,
        SessionOwner owner,
        CancellationToken token
    )
    {
        var placement = sessions.ExecutionPlacement(owner);
        var files = new CompactPlanFiles(
            sessions,
            owner,
            placement.Node,
            placement.Cwd,
            sessions.IdentityWorkspace(owner)
        );
        var content = CompactPlanInput.Content(call);
        var path = await files.SaveAsync(content, token);
        return new(files, owner, path, content, SessionWait.Text(call["rawArgsText"]) is null);
    }

    internal async Task<string> ReadAsync(string requestedPath, CancellationToken token)
    {
        RequirePath(requestedPath);
        content = await files.ReadAsync(requestedPath, token);
        return content;
    }

    internal async Task ApplyAsync(JsonObject call, CancellationToken token)
    {
        var name = SessionWait.Text(call["name"]);
        var args =
            call["args"] as JsonObject
            ?? throw new InvalidDataException("Repair tool arguments must be an object.");
        if (name == "edit")
            RequirePath(SessionWait.Text(args["filePath"]));
        else if (name == "apply_patch")
        {
            var input =
                SessionWait.Text(args["input"])
                ?? throw new InvalidDataException("apply_patch requires input string.");
            var patches = WorkspacePatch.Parse(input);
            if (patches.Length != 1 || patches[0].Action != "update")
                throw new InvalidDataException(
                    "Repair patches must update only the pending compact repair file."
                );
            RequirePath(patches[0].Path);
        }
        else
            throw new InvalidDataException(
                "Only edit or apply_patch may repair compact arguments."
            );
        await files.ExecuteAsync(name, args, token);
        content = await files.ReadAsync(FilePath, token);
    }

    private void RequirePath(string? path)
    {
        if (path != FilePath)
            throw new InvalidDataException(
                "Only the pending repair file for this compact operation may be used."
            );
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            await files.ExecuteAsync(
                "apply_patch",
                new JsonObject
                {
                    ["input"] = "*** Begin Patch\n*** Delete File: " + FilePath + "\n*** End Patch",
                },
                CancellationToken.None
            );
        }
        catch (Exception error)
            when (error
                    is IOException
                        or InvalidDataException
                        or UnauthorizedAccessException
                        or ArgumentException
                        or NotSupportedException
                        or InvalidOperationException
                        or ToolAuthorizationUnavailableException
            )
        {
            owner.Entry.RecordBestEffortFailure(error);
        }
    }
}
