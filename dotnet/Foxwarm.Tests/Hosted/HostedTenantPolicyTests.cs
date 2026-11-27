using System.Text.Json.Nodes;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Limits;
using Foxwarm.Sessions;

namespace Foxwarm.Tests.Hosted;

// A tenant's own limits and settings (tenants.limits, tenants.settings): reading them, and the
// journal off switch they carry.
[Trait("Backend", "postgres")]
public sealed class HostedTenantPolicyTests
{
    private static IReadOnlyList<JsonObject> Messages(string text) =>
        [new JsonObject { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = text }) }];

    private static ChatResult Result(long input, long output) =>
        new(
            new JsonObject { ["role"] = "model", ["parts"] = new JsonArray(new JsonObject { ["text"] = "ok" }) },
            new JsonObject { ["cachedTokens"] = 0, ["inputTokens"] = input, ["outputTokens"] = output }
        );

    private static async Task<(HostedTestDatabase Database, TenantDb Tenant)> TenantAsync()
    {
        var server = await PostgresServer.SharedAsync();
        var database = await server.CreateDatabaseAsync();
        var tenantId = await database.TenantIdAsync();
        var epoch = await database.TakeLeaseAsync(tenantId);
        return (database, new TenantDb(database.OpenApp(), tenantId, epoch));
    }

    private static async Task<string> RequestAsync(PgLlmJournalStore store, string session, string text)
    {
        var id = await store.BeginRequestAsync(session, "chat", 0, "System", new JsonArray(), Messages(text), "m/model", "cache");
        await store.AppendAttemptStartAsync(id, 1, "m/model", null, "openai-responses", new JsonObject { ["input"] = text }, "System");
        await store.AppendChatResultAsync(
            id,
            1,
            Result(10, 5),
            redaction: new Foxwarm.Models.LlmRedactionRecord(
                session,
                "chat",
                "m/model",
                "m",
                "openai-responses",
                null,
                null,
                1,
                0,
                new JsonObject { ["private_email"] = 1 },
                new JsonObject(),
                1,
                1,
                0,
                1,
                3.5,
                false
            )
        );
        return id;
    }

    [Fact]
    public async Task WithTheJournalOffOnlyTheUsageAndRedactionRowsAreWritten()
    {
        var (database, tenant) = await TenantAsync();
        await using var _ = database;
        await using var store = new PgLlmJournalStore(tenant);
        var recorded = await RequestAsync(store, "s", "recorded");
        store.Recording = false;
        var unrecorded = await RequestAsync(store, "s", "unrecorded");

        // One request's content, both requests' usage and redaction rows.
        Assert.Equal(1L, await database.ScalarAsync("SELECT count(*) FROM llm_journal_requests"));
        Assert.Equal(1L, await database.ScalarAsync("SELECT count(*) FROM llm_journal_attempt_starts"));
        Assert.Equal(1L, await database.ScalarAsync("SELECT count(*) FROM llm_journal_attempt_results"));
        Assert.Equal(
            0L,
            await database.ScalarAsync("SELECT count(*) FROM llm_journal_objects WHERE payload LIKE '%unrecorded%'")
        );
        Assert.Equal(2L, await database.ScalarAsync("SELECT count(*) FROM llm_usage"));
        Assert.Equal(
            "s|chat|m/model|openai-responses|10|5",
            await database.ScalarAsync(
                "SELECT session_id||'|'||purpose||'|'||model_key||'|'||provider_type||'|'||input_tokens||'|'||output_tokens FROM llm_usage WHERE request_id = $1",
                unrecorded
            )
        );
        Assert.Equal(2L, await database.ScalarAsync("SELECT count(*) FROM llm_redaction"));
        // The usage overview counts both.
        var cells = store.QueryUsage([0, long.MaxValue], null);
        Assert.Equal(20, cells.Sum(cell => cell.InputTokens));
        Assert.Equal(["s"], store.UsageSessions(0, long.MaxValue));

        // Reconstruction: the recorded one is complete, the other one wasn't recorded.
        Assert.Equal("complete", (await store.ReconstructAsync(recorded))["completeness"]!.GetValue<string>());
        var answer = await store.ReconstructAsync(unrecorded);
        Assert.Equal(PgLlmJournalStore.NotRecorded, answer["completeness"]!.GetValue<string>());
        Assert.Contains("wasn't recorded", answer["reason"]!.GetValue<string>());
        // The request's start data went with its success.
        Assert.Equal(0, store.UnrecordedLiveCount);
        // A later owner, with recording on again, still answers that it wasn't recorded.
        await using var next = new PgLlmJournalStore(tenant);
        await next.BackfillUsageAsync(CancellationToken.None);
        Assert.Equal(
            PgLlmJournalStore.NotRecorded,
            (await next.ReconstructAsync(unrecorded))["completeness"]!.GetValue<string>()
        );
        Assert.Single(await next.ListAsync(null, null, null, null, 10));
        Assert.True(next.UsageCoverage().Complete);
    }

    [Fact]
    public async Task ALostUsageRowOfAnUnrecordedRequestLeavesTheCoverageIncomplete()
    {
        var (database, tenant) = await TenantAsync();
        await using var _ = database;
        await using var store = new PgLlmJournalStore(tenant) { Recording = false };
        await RequestAsync(store, "s", "counted");
        await store.BackfillUsageAsync(CancellationToken.None);
        Assert.True(store.UsageCoverage().Complete);
        PgLlmJournalStore.InsertUsageForTest = () =>
            throw new Npgsql.PostgresException("synthetic rejection", "ERROR", "ERROR", "22P02");
        try
        {
            await RequestAsync(store, "s", "lost");
        }
        finally
        {
            PgLlmJournalStore.InsertUsageForTest = null;
        }
        Assert.Equal(1L, await database.ScalarAsync("SELECT count(*) FROM llm_usage"));
        Assert.False(store.UsageCoverage().Complete);
        await using var next = new PgLlmJournalStore(tenant);
        Assert.False(next.UsageCoverage().Complete);
    }

    [Fact]
    public void SettingsParseTheJournalSwitchAndRetention()
    {
        Assert.Same(TenantSettings.Defaults, TenantSettings.Parse(null));
        Assert.Same(TenantSettings.Defaults, TenantSettings.Parse(new JsonObject { ["other"] = 1 }));
        var off = TenantSettings.Parse(JsonNode.Parse("{\"journal\": {\"enabled\": false, \"retentionDays\": 7}}")!.AsObject());
        Assert.False(off.JournalEnabled);
        var deployment = new JournalRetentionOptions(30);
        Assert.Equal(7, off.Retention(deployment).RetentionDays);
        // Unset keeps the deployment's; null is unlimited for this tenant.
        Assert.Equal(30, TenantSettings.Defaults.Retention(deployment).RetentionDays);
        var unlimited = TenantSettings.Parse(JsonNode.Parse("{\"journal\": {\"retentionDays\": null}}")!.AsObject());
        Assert.True(unlimited.JournalEnabled);
        Assert.Null(unlimited.Retention(deployment).RetentionDays);
        foreach (
            var (json, key) in new[]
            {
                ("{\"journal\": {\"enabled\": \"no\"}}", "settings.journal.enabled"),
                ("{\"journal\": {\"retentionDays\": 0}}", "settings.journal.retentionDays"),
                ("{\"journal\": {\"keep\": true}}", "settings.journal.keep"),
                ("{\"journal\": true}", "settings.journal"),
            }
        )
            Assert.StartsWith(
                key + " ",
                Assert.Throws<InvalidDataException>(() => TenantSettings.Parse(JsonNode.Parse(json)!.AsObject())).Message
            );
    }

    [Fact]
    public async Task TheTenantsRowSuppliesItsLimitsAndSettings()
    {
        var (database, tenant) = await TenantAsync();
        await using var _ = database;
        var (limits, settings) = await TenantPolicy.ReadAsync(tenant, default);
        Assert.Equal(TenantLimits.Defaults, limits);
        Assert.Equal(TenantSettings.Defaults, settings);
        await database.ExecuteOwnerAsync(
            "UPDATE tenants SET limits = '{\"busyTurns\": 2, \"uploadBytes\": 1048576}',"
                + " settings = '{\"journal\": {\"enabled\": false, \"retentionDays\": 3}}'"
        );
        (limits, settings) = await TenantPolicy.ReadAsync(tenant, default);
        Assert.Equal(TenantLimits.Defaults with { BusyTurns = 2, UploadBytes = 1048576 }, limits);
        Assert.False(settings.JournalEnabled);
        Assert.Equal(3, settings.JournalRetention!.RetentionDays);
    }
}
