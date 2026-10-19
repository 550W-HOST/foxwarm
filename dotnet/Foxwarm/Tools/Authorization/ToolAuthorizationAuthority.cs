using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal sealed class ToolAuthorizationUnavailableException()
    : Exception("Tool authorization policy is unavailable after two read/parse attempts.")
{
    internal const string Code = "TOOL_AUTH_POLICY_UNAVAILABLE";
}

internal sealed class ToolAuthorizationDeniedException(string message)
    : InvalidOperationException(message);

internal sealed class ToolAuthorizationAuthority(
    string dataRoot,
    Func<long>? clock = null,
    Func<CancellationToken, Task>? retryDelay = null
)
{
    private readonly string path = Path.Combine(
        Path.GetFullPath(dataRoot),
        "state",
        "tool-authorization.yaml"
    );
    private readonly object cacheGate = new();
    private ToolAuthorizationPolicy? cached;
    private long loadedAt;
    private long Now => clock?.Invoke() ?? Environment.TickCount64;
    internal Action<string>? InstallBoundary { get; set; }

    private ToolAuthorizationPolicy? Hit()
    {
        var now = Now;
        lock (cacheGate)
            return cached is not null && now - loadedAt < 10_000 ? cached : null;
    }

    private ToolAuthorizationPolicy Cache(ToolAuthorizationPolicy value)
    {
        var now = Now;
        lock (cacheGate)
        {
            cached = value;
            loadedAt = now;
            return value;
        }
    }

    internal void Invalidate()
    {
        lock (cacheGate)
            cached = null;
    }

    private ToolAuthorizationPolicy Read()
    {
        try
        {
            if (!WorkspaceTools.PolicyFileKind(path, out var missing))
            {
                if (missing)
                    return ToolAuthorizationPolicy.Compatibility();
                throw new InvalidDataException("Policy must be a readable regular file.");
            }
            using var stream = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete
            );
            if (stream.Length > ToolAuthorizationPolicy.MaxBytes)
                throw new InvalidDataException("Tool policy exceeds its byte limit.");
            using var output = new MemoryStream();
            var buffer = new byte[8192];
            int count;
            while ((count = stream.Read(buffer)) > 0)
            {
                if (output.Length + count > ToolAuthorizationPolicy.MaxBytes)
                    throw new InvalidDataException("Tool policy exceeds its byte limit.");
                output.Write(buffer, 0, count);
            }
            return ToolAuthorizationYaml.Parse(output.ToArray());
        }
        catch (Exception error)
            when ((error is FileNotFoundException or DirectoryNotFoundException)
                && !WorkspaceTools.PolicyFileKind(path, out var absent)
                && absent
            )
        {
            return ToolAuthorizationPolicy.Compatibility();
        }
    }

    internal ToolAuthorizationPolicy Load()
    {
        var value = Hit();
        if (value is not null)
            return value;
        try
        {
            return Cache(Read());
        }
        catch
        {
            try
            {
                return Cache(Read());
            }
            catch
            {
                throw new ToolAuthorizationUnavailableException();
            }
        }
    }

    internal async Task<ToolAuthorizationPolicy> LoadAsync(
        CancellationToken cancellationToken = default
    )
    {
        cancellationToken.ThrowIfCancellationRequested();
        var value = Hit();
        if (value is not null)
            return value;
        try
        {
            return Cache(Read());
        }
        catch
        {
            if (retryDelay is null)
                await Task.Delay(100, cancellationToken);
            else
                await retryDelay(cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                return Cache(Read());
            }
            catch
            {
                throw new ToolAuthorizationUnavailableException();
            }
        }
    }

    internal async Task InstallAsync(byte[] bytes, CancellationToken token)
    {
        _ = ToolAuthorizationYaml.Parse(bytes);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = Path.Combine(
            Path.GetDirectoryName(path)!,
            ".tool-authorization-" + Guid.NewGuid().ToString("N") + ".tmp"
        );
        try
        {
            InstallBoundary?.Invoke("captured");
            var options = new FileStreamOptions
            {
                Mode = FileMode.CreateNew,
                Access = FileAccess.Write,
                Share = FileShare.None,
                Options = FileOptions.Asynchronous,
            };
            if (!OperatingSystem.IsWindows())
                options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            await using (var stream = new FileStream(temporary, options))
            {
                await stream.WriteAsync(bytes, token);
                stream.Flush(true);
            }
            token.ThrowIfCancellationRequested();
            InstallBoundary?.Invoke("before-rename");
            File.Move(temporary, path, true);
            Invalidate();
        }
        finally
        {
            if (File.Exists(temporary))
                File.Delete(temporary);
        }
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
        if (name == "apply_patch")
        {
            var input =
                SessionWait.Text(args["input"])
                ?? throw new InvalidDataException("apply_patch requires input.");
            return WorkspacePatch
                .Parse(input)
                .Select(operation => new AuthorizationPath(
                    "input",
                    operation.Path,
                    AuthorizationPaths.CanonicalPotential(ResolvePatchPath(operation.Path, true))
                ))
                .ToArray();
        }
        if (name is "send_file" or "run_script" or "start_toolscript_run" && raw is not null)
            raw = SessionGoal.Trim(raw);
        if (raw is null || raw.Length == 0)
            return [];
        var resolved = name switch
        {
            "read" or "set_config" or "send_file" or "run_script" or "start_toolscript_run" =>
                ResolveReadWrite(raw, true),
            "node_create_auth_token" => PrivateNodeTokenPath(raw),
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

    internal async Task<byte[]> CaptureConfigCandidateAsync(
        string raw,
        bool policy,
        CancellationToken token
    )
    {
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
