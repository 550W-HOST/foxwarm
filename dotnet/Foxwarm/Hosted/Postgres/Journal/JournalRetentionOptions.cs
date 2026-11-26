using System.Text.Json.Nodes;

namespace Foxwarm.Hosted.Postgres;

/// <summary>
/// The deployment's journal retention (plan C11, U14(c)): <c>journal: {retentionDays}</c>.
/// Unset keeps the journal without limit. Requests and attempts older than the retention
/// are deleted by the owner's daily job, the usage ledger is kept.
/// </summary>
internal sealed record JournalRetentionOptions(int? RetentionDays)
{
    internal static readonly JournalRetentionOptions Unlimited = new((int?)null);

    /// <summary>
    /// Reads the deployment configuration's <c>journal</c> value. A missing or null value is
    /// unlimited; anything else must be an object whose only key is a positive whole
    /// <c>retentionDays</c>. Violations name the key.
    /// </summary>
    internal static JournalRetentionOptions FromDeployment(JsonNode? journal)
    {
        if (journal is null)
            return Unlimited;
        if (journal is not JsonObject settings)
            throw new InvalidDataException("journal must be a mapping.");
        foreach (var (key, _) in settings)
            if (key != "retentionDays")
                throw new InvalidDataException($"journal.{key} is not a deployment setting.");
        var days = settings["retentionDays"];
        if (days is null)
            return Unlimited;
        if (
            days is JsonValue value
            && Foxwarm.Sessions.SessionWait.Number(value) is double number
            && number >= 1
            && number <= int.MaxValue
            && Math.Floor(number) == number
            && value.GetValueKind() == System.Text.Json.JsonValueKind.Number
        )
            return new((int)number);
        throw new InvalidDataException("journal.retentionDays must be a positive whole number of days.");
    }

    /// <summary>The creation time before which requests are deleted, or null when unlimited.</summary>
    internal long? Cutoff(DateTimeOffset now) =>
        RetentionDays is int days ? now.ToUnixTimeMilliseconds() - days * 86_400_000L : null;
}
