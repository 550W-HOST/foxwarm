using System.Text.RegularExpressions;

namespace Foxwarm.Models;

/// <summary>
/// Recognizes model configurations that obviously cannot authenticate, so first-run Setup
/// does not finish with an unfinished template. Keyless local gateways remain valid.
/// </summary>
internal static partial class ModelApiKeys
{
    // Hosted services whose API always requires a key. Unknown and local endpoints are not
    // judged: self-hosted gateways commonly run without one.
    private static readonly string[] KeyRequiredHosts =
    [
        "api.openai.com",
        "api.anthropic.com",
        "openrouter.ai",
        "api.deepseek.com",
        "generativelanguage.googleapis.com",
        "api.x.ai",
        "api.mistral.ai",
        "api.groq.com",
    ];

    [GeneratedRegex(
        "^(your[-_ ].*|.*[-_ ]here|replace[-_ ]?me|replace[-_ ]with[-_ ].*|change[-_ ]?me|placeholder|sk-\\.\\.\\.|sk-x+|x{3,}|<[^>]*>)$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant
    )]
    private static partial Regex PlaceholderPattern();

    internal static bool IsPlaceholder(string? key) =>
        key is not null && PlaceholderPattern().IsMatch(key.Trim());

    internal static bool RequiresKey(string? baseUrl)
    {
        if (!Uri.TryCreate(baseUrl ?? "", UriKind.Absolute, out var uri))
            return false;
        var host = uri.IdnHost.TrimEnd('.').ToLowerInvariant();
        return KeyRequiredHosts.Any(known =>
            host == known || host.EndsWith("." + known, StringComparison.Ordinal)
        );
    }

    /// <summary>
    /// Returns the first concrete provider whose key is a template placeholder, or that has no
    /// key although its endpoint requires one. Legacy app-level fallback keys count as set.
    /// </summary>
    internal static string? FirstUnusableProvider(HostModels catalog, out bool placeholder)
    {
        foreach (var leaf in catalog.All.Where(model => !model.IsVirtual))
        {
            if (IsPlaceholder(leaf.Token))
            {
                placeholder = true;
                return leaf.ProviderKey;
            }
            if (leaf.Token.Trim().Length == 0 && RequiresKey(leaf.BaseUrl))
            {
                placeholder = false;
                return leaf.ProviderKey;
            }
        }
        placeholder = false;
        return null;
    }

    internal static void EnsureUsableForFirstRun(HostModels catalog)
    {
        var provider = FirstUnusableProvider(catalog, out var placeholder);
        if (provider is null)
            return;
        throw new InvalidDataException(
            placeholder
                ? $"Replace the placeholder API key for the {provider} provider with your key."
                : $"Add an API key for the {provider} provider."
        );
    }
}
