using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Limits;

namespace Foxwarm.Hosted;

/// <summary>
/// A tenant's operator-owned settings (<c>tenants.settings</c>) this runtime applies: the
/// journal switch and its retention. Other keys belong to other owners and are left alone.
/// </summary>
/// <param name="JournalEnabled">Whether request content is journaled (default on).</param>
/// <param name="JournalRetention">
/// The tenant's own retention, over the deployment's <c>journal.retentionDays</c>; null keeps
/// the deployment's.
/// </param>
internal sealed record TenantSettings(bool JournalEnabled, JournalRetentionOptions? JournalRetention)
{
    internal static TenantSettings Defaults { get; } = new(true, null);

    /// <summary>
    /// The column's <c>journal</c> value: <c>{enabled: bool, retentionDays: positive whole
    /// number or null}</c>, where null is unlimited. Violations name the key.
    /// </summary>
    internal static TenantSettings Parse(JsonObject? column)
    {
        if (column?["journal"] is not { } journal)
            return Defaults;
        if (journal is not JsonObject settings)
            throw new InvalidDataException("settings.journal must be an object.");
        var enabled = true;
        JournalRetentionOptions? retention = null;
        foreach (var (key, value) in settings)
            switch (key)
            {
                case "enabled":
                    enabled =
                        value is JsonValue flag && flag.GetValueKind() is JsonValueKind.True or JsonValueKind.False
                            ? flag.GetValue<bool>()
                            : throw new InvalidDataException("settings.journal.enabled must be true or false.");
                    break;
                case "retentionDays":
                    retention =
                        value is null
                            ? JournalRetentionOptions.Unlimited
                            : Retention(value);
                    break;
                default:
                    throw new InvalidDataException($"settings.journal.{key} is not a tenant setting.");
            }
        return new(enabled, retention);
    }

    private static JournalRetentionOptions Retention(JsonNode value)
    {
        try
        {
            return JournalRetentionOptions.FromDeployment(new JsonObject { ["retentionDays"] = value.DeepClone() });
        }
        catch (InvalidDataException)
        {
            throw new InvalidDataException(
                "settings.journal.retentionDays must be a positive whole number of days or null."
            );
        }
    }

    /// <summary>The retention the owner's job applies: the tenant's own, else the deployment's.</summary>
    internal JournalRetentionOptions Retention(JournalRetentionOptions deployment) =>
        JournalRetention ?? deployment;
}

/// <summary>Reads a tenant's limits and settings from its <c>tenants</c> row at activation.</summary>
internal static class TenantPolicy
{
    internal static async Task<(TenantLimits Limits, TenantSettings Settings)> ReadAsync(
        TenantDb database,
        CancellationToken token
    )
    {
        var (limits, settings) = await database
            .ReadAsync(
                async (tx, cancel) =>
                {
                    await using var command = tx.Command(
                        "SELECT limits::text, settings::text FROM tenants WHERE tenant_id = $1",
                        tx.TenantId
                    );
                    await using var reader = await command.ExecuteReaderAsync(cancel).ConfigureAwait(false);
                    return await reader.ReadAsync(cancel).ConfigureAwait(false)
                        ? (reader.GetString(0), reader.GetString(1))
                        : throw new InvalidDataException("The tenant's row is missing.");
                },
                token: token
            )
            .ConfigureAwait(false);
        return (
            TenantLimits.Parse(JsonNode.Parse(limits) as JsonObject),
            TenantSettings.Parse(JsonNode.Parse(settings) as JsonObject)
        );
    }
}
