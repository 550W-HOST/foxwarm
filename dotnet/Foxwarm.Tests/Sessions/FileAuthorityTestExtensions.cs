using Foxwarm.Sessions;

namespace Foxwarm.Tests;

/// <summary>File-mode views of a bound Session authority store for tests.</summary>
internal static class FileAuthorityTestExtensions
{
    internal static string AuthorityPath(this ISessionAuthority store) =>
        ((PersistentSessionAuthorityStore)store).AuthorityPath;
}
