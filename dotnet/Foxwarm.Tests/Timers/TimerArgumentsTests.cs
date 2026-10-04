using System.Diagnostics;
using System.Text.Json.Nodes;
using Foxwarm.Timers;

namespace Foxwarm.Tests;

public sealed class TimerArgumentsTests
{
    [Fact]
    public async Task ISO_absolute_dates_match_actual_native_Source_parsing_for_offsets_date_only_fraction_fold_gap_and_rollover()
    {
        using var temp = new TempDirectory(); var cases = new JsonArray();
        foreach (var zone in new[] { "UTC", "America/New_York", "Australia/Lord_Howe", "Africa/Casablanca", "Asia/Kathmandu" })
            foreach (var text in new[] { "2027-03-14T02:30:00", "2026-11-01T01:30:00", "2026-10-04T02:15:00", "2027-04-11T02:30:00", "2027-02-30T12:30:45.123456Z", "2027-01-31T24:00:00.000Z", "2027-01-01", "2027-01-01T12:00:00+05:45", "2027-01-01T12:00:00-0330" }) cases.Add(new JsonObject { ["zone"] = zone, ["text"] = text });
        var input = Path.Combine(temp.Path, "cases.json"); await File.WriteAllTextAsync(input, cases.ToJsonString()); var start = new ProcessStartInfo("node") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        start.ArgumentList.Add("--input-type=module"); start.ArgumentList.Add("-e"); start.ArgumentList.Add("import fs from 'node:fs'; const rows=JSON.parse(fs.readFileSync(process.argv[1])); console.log(JSON.stringify(rows.map(row=>{process.env.TZ=row.zone;return {...row,time:Date.parse(row.text)}}))); "); start.ArgumentList.Add(input);
        using var process = Process.Start(start)!; var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync(); await process.WaitForExitAsync(); Assert.True(process.ExitCode == 0, await error);
        foreach (var row in JsonNode.Parse(await output)!.AsArray().OfType<JsonObject>()) Assert.True(row["time"]!.GetValue<double>() == TimerArguments.Absolute(row["text"]!, TimeZoneInfo.FindSystemTimeZoneById(row["zone"]!.GetValue<string>())), row["zone"] + " " + row["text"]);
    }
    [Fact]
    public void Real_schedule_validation_retains_blank_zero_placeholders_and_preserves_fractional_absolute_value()
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); var at = now + 60000.25;
        var value = TimerArguments.Normalize(new JsonObject { ["at"] = at, ["afterSeconds"] = 0, ["cron"] = "" }, required: true); Assert.Equal(at, value.At); Assert.Null(value.Cron);
        Assert.False(TimerArguments.Normalize(new JsonObject { ["at"] = "", ["afterSeconds"] = 0, ["cron"] = "" }, required: false).Provided);
        Assert.Throws<InvalidDataException>(() => TimerArguments.Normalize(new JsonObject { ["afterSeconds"] = 0 }, required: true));
        Assert.Throws<InvalidDataException>(() => TimerArguments.Normalize(new JsonObject { ["at"] = at, ["afterSeconds"] = -1 }, required: true));
        Assert.Throws<InvalidDataException>(() => TimerArguments.Normalize(new JsonObject { ["cron"] = "* * * * * *", ["afterSeconds"] = 1 }, required: true));
        Assert.Throws<InvalidDataException>(() => TimerArguments.Normalize(new JsonObject { ["at"] = now - 1 }, required: true));
    }
}
