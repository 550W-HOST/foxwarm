using System.Text.Json.Nodes;
using Foxwarm.Hosted.Postgres;

namespace Foxwarm.Tests.Hosted;

public sealed class JournalRetentionOptionsTests
{
    [Fact]
    public void Unset_retention_is_unlimited_and_days_set_the_cutoff()
    {
        Assert.Null(JournalRetentionOptions.FromDeployment(null).RetentionDays);
        Assert.Null(JournalRetentionOptions.FromDeployment(new JsonObject()).RetentionDays);
        Assert.Null(JournalRetentionOptions.FromDeployment(new JsonObject { ["retentionDays"] = null }).RetentionDays);
        Assert.Null(JournalRetentionOptions.Unlimited.Cutoff(DateTimeOffset.UnixEpoch));
        var options = JournalRetentionOptions.FromDeployment(new JsonObject { ["retentionDays"] = 30 });
        Assert.Equal(30, options.RetentionDays);
        var now = DateTimeOffset.UnixEpoch.AddDays(100);
        Assert.Equal(DateTimeOffset.UnixEpoch.AddDays(70).ToUnixTimeMilliseconds(), options.Cutoff(now));
    }

    [Theory]
    [InlineData("""{"enabled":false}""", "journal.enabled")]
    [InlineData("""{"retentionDays":30,"enabled":true}""", "journal.enabled")]
    [InlineData("""{"retentionDays":0}""", "journal.retentionDays")]
    [InlineData("""{"retentionDays":-1}""", "journal.retentionDays")]
    [InlineData("""{"retentionDays":1.5}""", "journal.retentionDays")]
    [InlineData("""{"retentionDays":"30"}""", "journal.retentionDays")]
    [InlineData("""{"retentionDays":true}""", "journal.retentionDays")]
    [InlineData("""[30]""", "journal")]
    [InlineData("""30""", "journal")]
    public void Invalid_settings_name_the_key(string json, string key)
    {
        var error = Assert.Throws<InvalidDataException>(() =>
            JournalRetentionOptions.FromDeployment(JsonNode.Parse(json))
        );
        Assert.StartsWith(key + " ", error.Message);
    }
}
