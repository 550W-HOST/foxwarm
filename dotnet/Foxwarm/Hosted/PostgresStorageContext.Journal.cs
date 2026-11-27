using Foxwarm.Hosted.Postgres;
using Foxwarm.Models;

namespace Foxwarm.Hosted;

internal sealed partial class PostgresStorageContext
{
    partial void CreateJournal(ref ILlmJournalStore? store) =>
        store = new PgLlmJournalStore(Database);

    /// <summary>
    /// Starts the owner's daily journal retention with the deployment's
    /// <c>journal.retentionDays</c> (<see cref="JournalRetentionOptions.FromDeployment"/>).
    /// Unlimited retention starts nothing; the job stops with the journal.
    /// </summary>
    internal void StartJournalRetention(JournalRetentionOptions options) =>
        ((PgLlmJournalStore)Journal).StartRetention(options);

    /// <summary>
    /// Applies the tenant's journal switch (<see cref="TenantSettings.JournalEnabled"/>): off
    /// writes no request content, only the usage-ledger and redaction rows.
    /// </summary>
    internal void ApplyJournalSettings(TenantSettings settings) =>
        ((PgLlmJournalStore)Journal).Recording = settings.JournalEnabled;

    /// <summary>
    /// Opens the tenant's text-redaction cache with its derived store key, the opener
    /// <c>InstanceSecrets</c> takes; null leaves redaction memory-only.
    /// </summary>
    internal ITextRedactionStore? OpenTextRedaction(byte[] key, TimeProvider? clock = null) =>
        PgTextRedactionStore.Open(Database, key, TextRedactor.DefaultKnownBytes, clock);
}
