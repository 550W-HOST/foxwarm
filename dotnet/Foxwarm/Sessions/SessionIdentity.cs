using System.Text;
using System.Text.RegularExpressions;

namespace Foxwarm.Sessions;

/// <summary>Canonical Session IDs are independent of HTTP route encoding and filesystem artifact layout.</summary>
public static partial class SessionIdentity
{
    public static bool IsLegacyGenerated(string id) =>
        id.Length == 34
        && id.StartsWith("s_", StringComparison.Ordinal)
        && id.AsSpan(2).ToString().All(Uri.IsHexDigit);

    public static bool IsValid(string? id)
    {
        if (string.IsNullOrEmpty(id) || id.Contains('\0'))
            return false;
        var slash = id.IndexOf('/');
        if (slash < 0)
            return true; // TS main Agent names: nonempty without '/'.
        return slash > 0
            && slash + 1 < id.Length
            && id.LastIndexOf('/') == slash
            && AgentName().IsMatch(id[..slash]);
    }

    public static string Agent(string id)
    {
        if (!IsValid(id))
            throw new InvalidDataException("Invalid Session ID.");
        var slash = id.IndexOf('/');
        return slash < 0 ? "main" : id[..slash];
    }

    public static string Build(string agent, string sessionName)
    {
        if (
            !AgentName().IsMatch(agent)
            || string.IsNullOrEmpty(sessionName)
            || sessionName.Contains('/')
            || sessionName.Contains('\0')
        )
            throw new InvalidDataException("Invalid Agent or Session name.");
        return agent == "main" ? sessionName : agent + "/" + sessionName;
    }

    public static string ExecDirectorySegment(string id)
    {
        if (!IsValid(id))
            throw new InvalidDataException("Invalid exec owner Session ID.");
        if (IsLegacyGenerated(id))
            return id;
        return "id_"
            + Convert
                .ToBase64String(Encoding.UTF8.GetBytes(id))
                .TrimEnd('=')
                .Replace('+', '-')
                .Replace('/', '_');
    }

    [GeneratedRegex("^[a-zA-Z0-9_-]+$", RegexOptions.CultureInvariant)]
    private static partial Regex AgentName();
}
