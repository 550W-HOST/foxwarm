using System.Security.Cryptography;
using System.Text;

namespace Foxwarm.Models;

internal enum ModelRequestScope { LowLevel, Canonical, CompactPlan }

internal static class ProviderPromptCache
{
    internal static string Resolve(string provider, string? sessionId, string lineage) =>
        provider == "openai-ws" && !string.IsNullOrEmpty(sessionId)
            ? Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sessionId))).ToLowerInvariant() : lineage;
}
