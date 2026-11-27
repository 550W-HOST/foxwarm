using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Storage;

namespace Foxwarm.Tools;

internal sealed class ToolAuthorizationUnavailableException()
    : Exception("Tool authorization policy is unavailable after two read/parse attempts.")
{
    internal const string Code = "TOOL_AUTH_POLICY_UNAVAILABLE";
}

// A call operation rules cannot decide because a resource or fact they test, or the call's
// operations themselves, could not be established. It is rejected before dispatch.
internal sealed class ToolAuthorizationUnresolvedException(string message)
    : ToolAuthorizationDeniedException(message)
{
    internal override string ErrorType => "tool_authorization_unresolved";
}

internal class ToolAuthorizationDeniedException(string message) : InvalidOperationException(message)
{
    internal virtual string ErrorType => "tool_authorization_denied";

    // Additional model-facing fields of the result beside the error.
    internal virtual JsonObject? ResultFields => null;

    // The type is the result's code: Activity classifies denials, approvals and skips by it.
    internal JsonObject ToolError()
    {
        var result = ToolFailure.Result(Message, ErrorType);
        foreach (var pair in ResultFields ?? [])
            result[pair.Key] = pair.Value?.DeepClone();
        return result;
    }
}

// One asking check of a call: the call itself or another request it must pass, with its
// assessment and the fingerprint an approval of it covers.
internal sealed record ApprovalCheck(
    string Id,
    ResolvedTool Resolved,
    AuthorizationAssessment Assessment,
    string Fingerprint,
    bool Primary
)
{
    // The facts the fingerprint binds, as the approver sees them.
    internal ToolAuthorizationRequest Facts { get; init; } = Assessment.Request;
}

// Asking checks that no approval covers. The dispatch gate turns them into one approval request
// for the call (Resolved), at the stage they were found; anywhere else (a check after the
// approval, a recheck outside the approved invocation) they are refused.
internal sealed class ToolApprovalRequiredException(
    IReadOnlyList<ApprovalCheck> checks,
    ResolvedTool resolved,
    ToolApprovalStage stage = ToolApprovalStage.Call,
    ToolAuthorizationRequest? callFacts = null
) : ToolAuthorizationDeniedException(Text(checks[0]))
{
    internal ToolApprovalRequiredException(
        AuthorizationAssessment assessment,
        ResolvedTool resolved,
        string fingerprint
    )
        : this(
            [new("primary", resolved, assessment, fingerprint, true)],
            resolved,
            callFacts: assessment.Request
        ) { }

    internal IReadOnlyList<ApprovalCheck> Checks => checks;

    // The first asking check: the call itself when it asks.
    internal AuthorizationAssessment Assessment => checks[0].Assessment;

    // The call the approval is for.
    internal ResolvedTool Resolved => resolved;

    internal ToolApprovalStage Stage => stage;

    // The call's own facts when its request was assessed, whether or not it asked itself.
    internal ToolAuthorizationRequest? CallFacts => callFacts;

    // The combined options of every asking check: the shortest deadline, and only the
    // identities every asking rule admits.
    internal ToolApprovalOptions Approval =>
        ToolApprovalOptions.Combine(checks.SelectMany(check => check.Assessment.Asking));

    internal override string ErrorType => "tool_approval_unavailable";

    private static string Text(ApprovalCheck check) =>
        $"This call needs approval for a step its approval does not cover ({check.Resolved.Source} `{check.Resolved.Name}`, rule {RuleId(check.Assessment)}), and approval can't be requested at this point. It was not executed.";

    // The failure of a call whose re-check after approval finds an ask the approval did not
    // list: policy or the call's facts changed while it waited.
    internal ToolApprovalOutcomeException ChangedAfterApproval()
    {
        var check = checks[0];
        return new(
            "tool_approval_unavailable",
            $"This call changed while it waited for approval: {check.Resolved.Source} `{check.Resolved.Name}` now needs approval under rule {RuleId(check.Assessment)}, which the approval did not cover. It was not executed."
        );
    }

    private static string RuleId(AuthorizationAssessment assessment) =>
        assessment.Asking.FirstOrDefault() is { } layer
            ? SessionWait.Text(layer.Decision.Rule?["id"]) ?? "defaultAction"
            : "defaultAction";
}

// Final outcome of an approval request that did not approve the call.
internal sealed class ToolApprovalOutcomeException(
    string type,
    string message,
    string? approvalId = null,
    string? note = null
) : ToolAuthorizationDeniedException(message)
{
    internal override string ErrorType => type;
    internal override JsonObject? ResultFields
    {
        get
        {
            var fields = new JsonObject();
            if (note is not null)
                fields["note"] = note;
            if (approvalId is not null)
                fields["approvalId"] = approvalId;
            return fields;
        }
    }
}

internal sealed class ToolAuthorizationAuthority
{
    private readonly IConfigDocumentStore documents;
    private readonly Func<long>? clock;
    private readonly Func<CancellationToken, Task>? retryDelay;
    private readonly object cacheGate = new();
    private ToolAuthorizationPolicy? cached;
    private long loadedAt;
    // The operator ceiling as last read; ceilingRead tells "no ceiling applies" from "not read".
    private ToolAuthorizationPolicy? ceiling;
    private bool ceilingRead;
    // Advanced under cacheGate by every invalidation. A value read from the store is published
    // only when no invalidation happened since its read began; otherwise it is read again, so
    // a read that started before an invalidation never republishes what it replaced.
    private long revision;

    // The policy file <data root>/state/tool-authorization.yaml.
    internal ToolAuthorizationAuthority(
        string dataRoot,
        Func<long>? clock = null,
        Func<CancellationToken, Task>? retryDelay = null
    )
        : this(new FileConfigDocuments(dataRoot), clock, retryDelay) { }

    internal ToolAuthorizationAuthority(
        IConfigDocumentStore documents,
        Func<long>? clock = null,
        Func<CancellationToken, Task>? retryDelay = null
    )
    {
        this.documents = documents;
        this.clock = clock;
        this.retryDelay = retryDelay;
    }

    private long Now => clock?.Invoke() ?? Environment.TickCount64;
    internal Action<string>? InstallBoundary { get; set; }

    // Where the operator ceiling comes from, set when the runtime is built; null (file mode)
    // means there is none.
    internal IOperatorCeilingSource? CeilingSource { get; set; }

    // The policy file Agent tools must not read; null when the policy isn't a file.
    internal string? PolicyPath => documents.PhysicalPath(ConfigDocumentName.ToolAuthorization);

    internal string PolicyLocator => documents.Locator(ConfigDocumentName.ToolAuthorization);

    // A hand-edited file is read again after 10 s; a policy that changes only through
    // installation stays cached until the installation invalidates it.
    private ToolAuthorizationPolicy? Hit()
    {
        var now = Now;
        lock (cacheGate)
            return cached is not null && (!documents.DirectEdits || now - loadedAt < 10_000)
                ? cached
                : null;
    }

    private void StorePolicy(ToolAuthorizationPolicy value)
    {
        cached = value;
        loadedAt = Now;
    }

    private void StoreCeiling(ToolAuthorizationPolicy? value)
    {
        ceiling = value;
        ceilingRead = true;
    }

    private long Revision()
    {
        lock (cacheGate)
            return revision;
    }

    // Stores and returns a value read since `seen`, unless an invalidation came between.
    private bool Publish<T>(long seen, T value, Action<T> store)
    {
        lock (cacheGate)
        {
            if (revision != seen)
                return false;
            store(value);
            return true;
        }
    }

    // A fresh read published under the current revision. Two failed reads in a row throw
    // ToolAuthorizationUnavailableException; a read overtaken by an invalidation is repeated
    // and doesn't count as a failure.
    private T ReadFresh<T>(Func<T> read, Action<T> store)
    {
        var failed = false;
        while (true)
        {
            var seen = Revision();
            T value;
            try
            {
                value = read();
            }
            catch
            {
                if (failed)
                    throw new ToolAuthorizationUnavailableException();
                failed = true;
                continue;
            }
            if (Publish(seen, value, store))
                return value;
        }
    }

    private async Task<T> ReadFreshAsync<T>(Func<T> read, Action<T> store, CancellationToken cancellationToken)
    {
        var failed = false;
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var seen = Revision();
            T value;
            try
            {
                value = read();
            }
            catch
            {
                if (failed)
                    throw new ToolAuthorizationUnavailableException();
                failed = true;
                if (retryDelay is null)
                    await Task.Delay(100, cancellationToken);
                else
                    await retryDelay(cancellationToken);
                continue;
            }
            if (Publish(seen, value, store))
                return value;
        }
    }

    // Drops the cached policy and ceiling. An installation calls it, and so does a change of the
    // operator ceiling (OperatorCeilingChanged), so the next check reads both again.
    internal void Invalidate()
    {
        lock (cacheGate)
        {
            revision++;
            cached = null;
            ceiling = null;
            ceilingRead = false;
        }
    }

    // The operator changed a ceiling document (NOTIFY foxwarm_operator): later checks read the
    // new ceiling, as they read a newly installed tenant policy.
    internal void OperatorCeilingChanged() => Invalidate();

    private bool CeilingHit(out ToolAuthorizationPolicy? value)
    {
        lock (cacheGate)
        {
            value = ceiling;
            return ceilingRead;
        }
    }

    private ToolAuthorizationPolicy? ReadCeiling() =>
        CeilingSource!.Read() is { } document ? OperatorCeiling.Parse(document.Text) : null;

    // The operator ceiling layer, or null when none applies. It is read and cached like the
    // policy, and fails closed the same way: two failed reads in a row throw
    // ToolAuthorizationUnavailableException, and every check then denies.
    internal ToolAuthorizationPolicy? LoadCeiling()
    {
        if (CeilingSource is null)
            return null;
        if (CeilingHit(out var value))
            return value;
        return ReadFresh(ReadCeiling, StoreCeiling);
    }

    internal async Task<ToolAuthorizationPolicy?> LoadCeilingAsync(CancellationToken cancellationToken = default)
    {
        if (CeilingSource is null)
            return null;
        cancellationToken.ThrowIfCancellationRequested();
        if (CeilingHit(out var value))
            return value;
        return await ReadFreshAsync(ReadCeiling, StoreCeiling, cancellationToken);
    }

    // The layers that precede the Agent layers, in evaluation order: the ceiling when one
    // applies, then the global policy.
    internal ToolAuthorizationPolicy[] GlobalLayers(ToolAuthorizationPolicy global) =>
        LoadCeiling() is { } value ? [value, global] : [global];

    // An absent policy is the compatibility policy; anything that can't be read as one bounded
    // value throws, and two failures in a row deny (ToolAuthorizationUnavailableException).
    private ToolAuthorizationPolicy Read()
    {
        if (
            documents.ReadBounded(ConfigDocumentName.ToolAuthorization, ToolAuthorizationPolicy.MaxBytes)
            is not { } bytes
        )
            return ToolAuthorizationPolicy.Compatibility();
        var policy = ToolAuthorizationYaml.Parse(bytes);
        ToolAuthorizationPolicy.Report("policy", policy);
        return policy;
    }

    internal ToolAuthorizationPolicy Load()
    {
        var value = Hit();
        if (value is not null)
            return value;
        return ReadFresh(Read, StorePolicy);
    }

    internal async Task<ToolAuthorizationPolicy> LoadAsync(
        CancellationToken cancellationToken = default
    )
    {
        cancellationToken.ThrowIfCancellationRequested();
        // Every caller evaluates the ceiling beside the policy; it is read here off the
        // synchronous evaluation path.
        await LoadCeilingAsync(cancellationToken);
        var value = Hit();
        if (value is not null)
            return value;
        return await ReadFreshAsync(Read, StorePolicy, cancellationToken);
    }

    internal async Task InstallAsync(byte[] bytes, CancellationToken token)
    {
        _ = ToolAuthorizationYaml.Parse(bytes);
        try
        {
            await documents.ReplaceAsync(
                ConfigDocumentName.ToolAuthorization,
                bytes,
                token,
                stage =>
                {
                    if (stage == AtomicJsonWriteStage.BeforeTempWrite)
                        InstallBoundary?.Invoke("captured");
                    else if (stage == AtomicJsonWriteStage.BeforeRename)
                        InstallBoundary?.Invoke("before-rename");
                }
            );
        }
        catch (AuthorityCommittedException error)
        {
            Invalidate();
            throw new AuthorityCommittedException(
                "Configuration committed but final durability failed.",
                error.InnerException!
            );
        }
        Invalidate();
    }
}

public sealed partial class WorkspaceTools
{
    internal IReadOnlyList<AuthorizationPath> AuthorizationFacts(string name, JsonObject args)
    {
        if (
            name is "run_script" or "start_toolscript_run"
            && SessionWait.Text(args["code"]) is string code
            && !string.IsNullOrWhiteSpace(code)
        )
            return [];
        string? raw = SessionWait.Text(args[name == "exec" ? "cwd" : "filePath"]);
        if (name == "edit" && args.ContainsKey("apply_patch"))
        {
            var input =
                SessionWait.Text(args["apply_patch"])
                ?? throw new InvalidDataException("apply_patch requires input.");
            return WorkspacePatch
                .Parse(input)
                .Select(operation =>
                    AgentFolder is { } scope
                        ? scope.Fact("apply_patch", operation.Path, ResolvePatchPath(operation.Path, true))
                        : new AuthorizationPath(
                            "apply_patch",
                            operation.Path,
                            AuthorizationPaths.CanonicalPotential(ResolvePatchPath(operation.Path, true))
                        )
                )
                .ToArray();
        }
        if (name is "send_file" or "run_script" or "start_toolscript_run" && raw is not null)
            raw = SessionGoal.Trim(raw);
        // An Agent-folder path, the empty one included, names a folder entry (the root for "").
        if (AgentFolder is { } folder && raw is not null)
            return name is "read" or "write" or "edit" or "set_config"
                ? [folder.Fact("filePath", raw, folder.Resolve(raw))]
                : throw new InvalidDataException("No Agent-folder path resolver for this capability.");
        if (raw is null || raw.Length == 0)
            return [];
        var resolved = name switch
        {
            "read" or "set_config" or "send_file" or "run_script" or "start_toolscript_run" =>
                ResolveReadWrite(raw, true),
            "node_create_auth_token" or "node_bootstrap_info" => PrivateNodeTokenPath(raw, name),
            "write" or "image_write_to_file" => ResolveReadWrite(raw, false),
            "edit" => ResolvePatchPath(raw, true),
            "exec" => Paths.ExecCwd(raw),
            _ => throw new InvalidDataException("No physical path resolver for this capability."),
        };
        return
        [
            new(
                name == "exec" ? "cwd" : "filePath",
                raw,
                AuthorizationPaths.CanonicalPotential(resolved)
            ),
        ];
    }

    // A candidate in the Agent folder: the same checks, over one committed version of the file,
    // read at once; that one buffer is the candidate.
    private async Task<byte[]> CaptureStoredCandidateAsync(string path, bool policy, CancellationToken token)
    {
        if (targetFiles is not AgentStoreFileOperations folder)
            throw new InvalidDataException("Configuration candidate must be a regular file.");
        return await folder.ReadCandidateAsync(path, policy ? ToolAuthorizationPolicy.MaxBytes : null, token)
            ?? throw new InvalidDataException("Configuration candidate exceeds its byte limit.");
    }

    internal async Task<byte[]> CaptureConfigCandidateAsync(
        string raw,
        bool policy,
        CancellationToken token
    )
    {
        if (AgentFolder is { } folder)
            return await CaptureStoredCandidateAsync(folder.Resolve(raw), policy, token);
        var path = ResolveReadWrite(raw, true);
        if (!RegularFile(path))
            throw new InvalidDataException("Configuration candidate must be a regular file.");
        await using var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete,
            8192,
            FileOptions.Asynchronous
        );
        if (!RegularFileHandle(stream, path))
            throw new InvalidDataException("Configuration candidate must be a regular file.");
        var size = stream.Length;
        if (policy && size > ToolAuthorizationPolicy.MaxBytes)
            throw new InvalidDataException("Configuration candidate exceeds its byte limit.");
        using var output = new MemoryStream();
        var buffer = new byte[8192];
        while (true)
        {
            var count = await stream.ReadAsync(buffer, token);
            if (count == 0)
                break;
            if (policy && output.Length + count > ToolAuthorizationPolicy.MaxBytes)
                throw new InvalidDataException("Configuration candidate exceeds its byte limit.");
            output.Write(buffer, 0, count);
        }
        return output.ToArray();
    }

    internal static bool PolicyFileKind(string path, out bool missing)
    {
        missing = false;
        if (OperatingSystem.IsLinux())
        {
            if (NativeFileKind.TryReadLinux(-100, path, 0, out var kind, out var error))
                return kind == "file";
            missing = error == 2;
            return false;
        }
        try
        {
            return (File.GetAttributes(path) & (FileAttributes.Directory | FileAttributes.Device))
                == 0;
        }
        catch (FileNotFoundException)
        {
            missing = true;
            return false;
        }
        catch (DirectoryNotFoundException)
        {
            missing = !File.Exists(Path.GetDirectoryName(path));
            return false;
        }
    }

    internal static bool RegularFileHandle(FileStream stream, string path) =>
        !OperatingSystem.IsLinux()
            ? RegularFile(path)
            : NativeFileKind.TryReadLinux(
                stream.SafeFileHandle.DangerousGetHandle().ToInt32(),
                "",
                0x1000,
                out var kind,
                out _
            )
                && kind == "file";
}
