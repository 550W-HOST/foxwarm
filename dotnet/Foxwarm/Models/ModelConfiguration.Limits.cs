using System.Collections.Immutable;
using System.Text.Json.Nodes;
using Foxwarm.Limits;
using Foxwarm.Storage;

namespace Foxwarm.Models;

internal sealed partial class ModelConfiguration
{
    /// <summary>
    /// The tenant's limits on configured channels, access identities and webhooks, checked when
    /// the app configuration is saved; null (file mode) is unlimited. The runtime sets them.
    /// </summary>
    internal TenantLimits? Limits { get; set; }

    /// <summary>Counted entries of an app configuration.</summary>
    internal readonly record struct ConfigurationCounts(int Channels, int Identities, int Webhooks);

    // The counts of the stored app configuration, read asynchronously; an unreadable document
    // counts nothing.
    private async Task<ConfigurationCounts> SavedConfigurationCountsAsync(CancellationToken token)
    {
        try
        {
            var bytes = await Documents.ReadAsync(ConfigDocumentName.Config, token).ConfigureAwait(false);
            var current = ConfigurationYaml.Parse(
                bytes is null ? "" : ConfigDocumentText.Decode(bytes),
                "app config"
            );
            var (channels, identities, webhooks) = Counts(
                current["channels"],
                AccessConfiguration.Normalize(current["access"], current.ContainsKey("access"))
            );
            return new(channels, identities, webhooks);
        }
        catch (InvalidDataException)
        {
            return default;
        }
    }

    // A save may keep or reduce a count above its limit (an imported installation), but not
    // raise a count past it.
    private static void RequireConfigurationCounts(
        TenantLimits limits,
        JsonObject candidate,
        ImmutableDictionary<string, AccessIdentity> access,
        ConfigurationCounts saved
    )
    {
        var (channels, identities, webhooks) = Counts(candidate["channels"], access);
        Require("channels", channels, saved.Channels, limits.Channels, "channels");
        Require("accessIdentities", identities, saved.Identities, limits.AccessIdentities, "access identities");
        Require("webhooks", webhooks, saved.Webhooks, limits.Webhooks, "webhooks");
    }

    private static (int Channels, int Identities, int Webhooks) Counts(
        JsonNode? channels,
        ImmutableDictionary<string, AccessIdentity> access
    ) =>
        (
            (channels as JsonObject)?.Count ?? 0,
            access.Count,
            access.Values.Count(identity => identity.Webhook is not null)
        );

    private static void Require(string key, int count, int saved, int limit, string noun)
    {
        if (count > limit && count > saved)
            throw new TenantLimitException(
                key,
                $"This installation can have at most {limit} {noun}; this configuration has {count}."
            );
    }
}
