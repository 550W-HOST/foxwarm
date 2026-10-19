using System.Security.Cryptography;
using System.Text;

namespace Foxwarm.Models;

internal enum ModelRequestScope
{
    LowLevel,
    Canonical,
    Btw,
    CompactPlan,
    BackgroundCompactPlan,
}

internal static class ProviderPromptCache
{
    internal static string Resolve(
        string provider,
        string? sessionId,
        string lineage,
        ModelRequestScope scope = ModelRequestScope.LowLevel
    ) =>
        provider == "openai-ws" && !string.IsNullOrEmpty(sessionId)
            ? Convert
                .ToHexString(
                    SHA256.HashData(
                        Encoding.UTF8.GetBytes(
                            sessionId
                                + (
                                    scope == ModelRequestScope.Btw ? "--btw"
                                    : scope == ModelRequestScope.BackgroundCompactPlan
                                        ? "--compact-plan"
                                    : ""
                                )
                        )
                    )
                )
                .ToLowerInvariant()
            : lineage;
}
