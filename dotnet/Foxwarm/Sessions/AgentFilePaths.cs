using System.Text;

namespace Foxwarm.Sessions;

/// <summary>
/// The path syntax of the Agent file store. A path is relative and '/'-separated: no leading
/// '/', no backslash, no empty, '.' or '..' segment, no control character (NUL included), at
/// most 255 UTF-8 bytes per segment and 4,096 in total, and in Unicode normalization form C.
/// A path is stored exactly as given, so two spellings of one name can't name two files and no
/// later normalization can turn a stored name into a traversal. The empty path is the Agent's
/// own directory, which only the Agent lifecycle creates or removes.
/// </summary>
internal static class AgentFilePaths
{
    internal const int MaxPathBytes = 4096;
    internal const int MaxSegmentBytes = 255;

    private static readonly UTF8Encoding StrictUtf8 = new(false, throwOnInvalidBytes: true);

    /// <summary>Returns <paramref name="path"/> when it is valid, else throws <see cref="AgentFilePathException"/>.</summary>
    internal static string Require(string path, bool allowRoot = false)
    {
        if (Problem(path, allowRoot) is { } problem)
            throw new AgentFilePathException(path, problem);
        return path;
    }

    /// <summary>Why <paramref name="path"/> isn't a store path, or null when it is one.</summary>
    internal static string? Problem(string? path, bool allowRoot = false)
    {
        if (path is null)
            return "it has an empty segment";
        if (path.Length == 0)
            return allowRoot ? null : "it has an empty segment";
        // Slash-rooted, drive-prefixed (`C:`, which a Windows file system resolves against a
        // drive rather than the base) or otherwise rooted on this platform.
        if (
            path[0] == '/'
            || path.Length >= 2 && path[1] == ':' && char.IsAsciiLetter(path[0])
            || Path.IsPathRooted(path)
        )
            return "absolute paths aren't allowed";
        if (path.Contains('\\'))
            return "backslashes aren't allowed";
        foreach (var character in path)
            if (char.IsControl(character))
                return "control characters aren't allowed";
        int bytes;
        try
        {
            bytes = StrictUtf8.GetByteCount(path);
        }
        catch (ArgumentException)
        {
            return "it isn't valid Unicode";
        }
        if (bytes > MaxPathBytes)
            return $"it is longer than {MaxPathBytes} bytes";
        if (!path.IsNormalized(NormalizationForm.FormC))
            return "it isn't in Unicode NFC form";
        foreach (var segment in path.Split('/'))
        {
            if (segment.Length == 0)
                return "it has an empty segment";
            if (segment is "." or "..")
                return "'.' and '..' segments aren't allowed";
            if (StrictUtf8.GetByteCount(segment) > MaxSegmentBytes)
                return $"a segment is longer than {MaxSegmentBytes} bytes";
        }
        return null;
    }

    /// <summary>The parent of a valid non-root path; the root's children have the root ("").</summary>
    internal static string Parent(string path)
    {
        var slash = path.LastIndexOf('/');
        return slash < 0 ? "" : path[..slash];
    }

    /// <summary>The proper ancestors of a valid path, nearest last, the root excluded.</summary>
    internal static string[] Ancestors(string path)
    {
        var result = new List<string>();
        for (var index = path.IndexOf('/'); index >= 0; index = path.IndexOf('/', index + 1))
            result.Add(path[..index]);
        return result.ToArray();
    }

    /// <summary>Whether <paramref name="path"/> is <paramref name="directory"/> or below it.</summary>
    internal static bool Within(string path, string directory) =>
        directory.Length == 0
        || path == directory
        || path.Length > directory.Length
            && path[directory.Length] == '/'
            && path.StartsWith(directory, StringComparison.Ordinal);
}

/// <summary>A path the Agent file store refuses (<see cref="AgentFilePaths"/>).</summary>
internal sealed class AgentFilePathException(string path, string problem)
    : ArgumentException($"Invalid path '{Printable(path)}': {problem}.")
{
    internal string Problem { get; } = problem;

    private static string Printable(string? path) =>
        path is null
            ? ""
            : new string(path.Select(character => char.IsControl(character) ? '?' : character).ToArray());
}

/// <summary>
/// A conditional write whose expectation doesn't hold: the file changed since the generation
/// the caller read, or a create found the file existing.
/// </summary>
internal sealed class AgentFileConflictException(string message) : IOException(message);

/// <summary>A valid path longer than the store can index; the store's own bound.</summary>
internal sealed class AgentFilePathTooLongException(string message) : ArgumentException(message);

/// <summary>A write refused at admission because it would exceed one of the <see cref="AgentStoreLimits"/>.</summary>
internal sealed class AgentStoreQuotaException(string limit, string message) : IOException(message)
{
    /// <summary><c>fileBytes</c>, <c>totalBytes</c> or <c>files</c>.</summary>
    internal string Limit { get; } = limit;
}

/// <summary>
/// The Agent store limits of one tenant (plan §7.2), checked when a write is admitted. A write
/// that doesn't grow the measured value is always admitted, so lowering a limit never blocks
/// deleting or shrinking files. <see cref="Files"/> counts entries: files, and directories that
/// exist only because they were created empty.
/// </summary>
internal sealed record AgentStoreLimits(long TotalBytes, long Files, long FileBytes)
{
    internal static AgentStoreLimits Default { get; } = new(2L << 30, 20_000, 64L << 20);
}

/// <summary>One write lane per Agent: writes to one Agent's files run one at a time, in order.</summary>
internal sealed class AgentWriteLanes
{
    private readonly Dictionary<string, (SemaphoreSlim Gate, int Users)> lanes = new(StringComparer.Ordinal);

    internal async Task<T> RunAsync<T>(string agent, Func<Task<T>> body, CancellationToken token)
    {
        SemaphoreSlim gate;
        lock (lanes)
        {
            var lane = lanes.TryGetValue(agent, out var existing) ? existing : (new SemaphoreSlim(1, 1), 0);
            lanes[agent] = (lane.Item1, lane.Item2 + 1);
            gate = lane.Item1;
        }
        try
        {
            await gate.WaitAsync(token).ConfigureAwait(false);
            try
            {
                return await body().ConfigureAwait(false);
            }
            finally
            {
                gate.Release();
            }
        }
        finally
        {
            lock (lanes)
            {
                var lane = lanes[agent];
                if (lane.Users == 1)
                {
                    lanes.Remove(agent);
                    lane.Gate.Dispose();
                }
                else
                    lanes[agent] = (lane.Gate, lane.Users - 1);
            }
        }
    }
}

/// <summary>How Agent store paths appear outside the store.</summary>
internal static class AgentStorePaths
{
    /// <summary>
    /// The endpoint of Agent store access in authorization facts (in place of a Node ID) and,
    /// for <c>node copy</c>, the caller's own Agent folder. Node IDs can't contain '@'.
    /// </summary>
    internal const string Endpoint = "@agent";

    /// <summary>The fact path of a store path: <c>&lt;agent&gt;/&lt;path&gt;</c>.</summary>
    internal static string Fact(string agent, string path) => path.Length == 0 ? agent : agent + "/" + path;

    /// <summary>
    /// The store root a policy root names for an Agent: `${agent.dir}` is the Agent's store
    /// root, `${agent.memoryDir}` its `memory`, and a suffix resolves as file mode resolves it
    /// (empty and `.` segments vanish, `..` removes one). Null when the text names no Agent
    /// root; <paramref name="refused"/> when it does in a form the store can't decide: a
    /// variable elsewhere than at the start, a suffix not after `/`, a `..` that leaves the
    /// Agent's namespace or a segment that isn't a store path.
    /// </summary>
    internal static string? PolicyRoot(string text, string agent, out bool refused)
    {
        refused = false;
        const string Directory = "${agent.dir}";
        const string Memory = "${agent.memoryDir}";
        var token =
            text.StartsWith(Memory, StringComparison.Ordinal) ? Memory
            : text.StartsWith(Directory, StringComparison.Ordinal) ? Directory
            : null;
        if (token is null)
        {
            refused =
                text.Contains(Directory, StringComparison.Ordinal)
                || text.Contains(Memory, StringComparison.Ordinal);
            return null;
        }
        var rest = text[token.Length..];
        if (rest.Length > 0 && rest[0] != '/' || rest.Contains("${", StringComparison.Ordinal))
        {
            refused = true;
            return null;
        }
        var segments = new List<string> { agent };
        if (token == Memory)
            segments.Add("memory");
        foreach (var segment in rest.Split('/'))
        {
            if (segment is "" or ".")
                continue;
            if (segment == "..")
            {
                if (segments.Count == 1)
                {
                    refused = true;
                    return null;
                }
                segments.RemoveAt(segments.Count - 1);
                continue;
            }
            segments.Add(segment);
        }
        // The reduced key, below the Agent, must be a store path itself.
        var relative = string.Join('/', segments.Skip(1));
        if (AgentFilePaths.Problem(relative, allowRoot: true) is not null)
        {
            refused = true;
            return null;
        }
        return string.Join('/', segments);
    }

    /// <summary>Whether a store fact path lies at or below a store root.</summary>
    internal static bool Within(string path, string root) =>
        path == root || path.StartsWith(root + "/", StringComparison.Ordinal);
}
