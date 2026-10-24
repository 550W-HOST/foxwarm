using System.Diagnostics;
using System.Text.Json.Nodes;
using Foxwarm.Timers;

namespace Foxwarm.Tests;

public sealed class CronScheduleTests
{
    private static long Stamp(JsonNode node) =>
        DateTimeOffset.Parse(node.GetValue<string>()).ToUnixTimeMilliseconds();

    private static JsonArray Values(CronValue[] values) =>
        new(
            values
                .Select(value =>
                    value.Number is double number
                        ? (JsonNode)JsonValue.Create(number)!
                        : JsonValue.Create(value.Constraint)!
                )
                .ToArray()
        );

    [Fact]
    public async Task Actual_pinned_Source_forward_fields_occurrences_and_fresh_cursors_match_the_complete_zone_corpus()
    {
        using var temp = new TempDirectory();
        var root =
            Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")
            ?? throw new InvalidOperationException("Owned Source checkout is required.");
        var output = Path.Combine(temp.Path, "oracle.json");
        var start = new ProcessStartInfo("node")
        {
            WorkingDirectory = root,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        start.ArgumentList.Add(
            Path.Combine(root, "dotnet", "Foxwarm.Tests", "Fixtures", "cron-forward-fixture-ts.mjs")
        );
        start.ArgumentList.Add(output);
        using var process = Process.Start(start)!;
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        Assert.True(process.ExitCode == 0, await stderr + await stdout);
        var rows = JsonNode.Parse(await File.ReadAllTextAsync(output))!.AsArray();
        Assert.True(rows.Count >= 115);
        var names = new[] { "second", "minute", "hour", "dayOfMonth", "month", "dayOfWeek" };
        foreach (var row in rows.OfType<JsonObject>())
        {
            var expression = row["expression"]!.GetValue<string>();
            var zone = TimeZoneInfo.FindSystemTimeZoneById(row["zone"]!.GetValue<string>());
            var id = row["id"]!.GetValue<string>();
            var cursor = Stamp(row["cursor"]!);
            var end = row["end"] is null ? (long?)null : Stamp(row["end"]!);
            var times = new List<long>();
            Exception? error = null;
            try
            {
                var cron = new CronSchedule(expression, cursor, zone, end);
                if (row["fields"] is JsonObject expected)
                    for (var field = 0; field < 6; field++)
                        Assert.True(
                            JsonNode.DeepEquals(
                                expected[names[field]],
                                Values(cron.FieldValues[field])
                            ),
                            id + " field " + names[field]
                        );
                for (var index = 0; index < row["count"]!.GetValue<int>(); index++)
                    times.Add(cron.Next());
            }
            catch (InvalidDataException caught)
            {
                error = caught;
            }
            Assert.True(
                (row["error"] is not null) == (error is not null),
                id + " " + expression + " Source=" + row["error"] + " C#=" + error?.Message
            );
            if (row["times"] is JsonArray prefix)
                Assert.True(
                    prefix.Select(value => value!.GetValue<long>()).SequenceEqual(times),
                    id + " partial prefix differs before no-next/error."
                );
            if (error is not null)
                continue;
            var expectedTimes = row["times"]!
                .AsArray()
                .Select(value => value!.GetValue<long>())
                .ToArray();
            Assert.True(
                expectedTimes.SequenceEqual(times),
                id
                    + " "
                    + expression
                    + " Source="
                    + string.Join(',', expectedTimes)
                    + " C#="
                    + string.Join(',', times)
            );
            var fresh = new List<long>();
            for (var index = 0; index < times.Count; index++)
            {
                cursor = new CronSchedule(expression, cursor, zone, end).Next();
                fresh.Add(cursor);
            }
            Assert.Equal(
                row["freshTimes"]!.AsArray().Select(value => value!.GetValue<long>()),
                fresh
            );
        }
    }

    [Fact]
    public async Task Actual_CronDate_elapsed_calendar_startOf_and_local_offset_resolution_match_through_gaps_folds_and_month_edges()
    {
        using var temp = new TempDirectory();
        var root = Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")!;
        var input = new JsonArray();
        foreach (
            var (zone, cursor) in new[]
            {
                ("America/New_York", "2024-03-10T06:30:17.900Z"),
                ("America/New_York", "2024-11-03T05:30:17.900Z"),
                ("America/New_York", "2024-11-03T06:30:17.900Z"),
                ("Europe/Berlin", "2024-03-31T00:30:17.900Z"),
                ("Europe/Berlin", "2024-10-27T00:30:17.900Z"),
                ("Australia/Lord_Howe", "2024-10-05T15:20:17.900Z"),
                ("Australia/Lord_Howe", "2024-04-06T14:40:17.900Z"),
                ("Africa/Casablanca", "2024-04-14T01:30:17.900Z"),
                ("Africa/Casablanca", "2024-03-10T01:30:17.900Z"),
                ("Pacific/Apia", "2011-12-29T20:30:17.900Z"),
                ("Asia/Kathmandu", "2024-01-31T20:30:17.900Z"),
                ("UTC", "2024-02-28T20:30:17.900Z"),
                ("UTC", "2023-02-28T20:30:17.900Z"),
                ("America/New_York", "2024-03-09T07:30:17.900Z"),
            }
        )
        foreach (
            var operations in new[]
            {
                new[] { "addHour", "addHour", "addMinute", "addSecond" },
                new[] { "addDay", "addDay", "addHour" },
                new[] { "addMonth", "addMonth", "addDay" },
            }
        )
            input.Add(
                new JsonObject
                {
                    ["zone"] = zone,
                    ["cursor"] = cursor,
                    ["operations"] = new JsonArray(
                        operations.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()
                    ),
                }
            );
        var inFile = Path.Combine(temp.Path, "input.json");
        var outFile = Path.Combine(temp.Path, "output.json");
        await File.WriteAllTextAsync(inFile, input.ToJsonString());
        var start = new ProcessStartInfo("node")
        {
            WorkingDirectory = root,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (
            var argument in new[]
            {
                Path.Combine(
                    root,
                    "dotnet",
                    "Foxwarm.Tests",
                    "Fixtures",
                    "cron-forward-fixture-ts.mjs"
                ),
                "--dates",
                inFile,
                outFile,
            }
        )
            start.ArgumentList.Add(argument);
        using var process = Process.Start(start)!;
        var stderr = process.StandardError.ReadToEndAsync();
        var stdout = process.StandardOutput.ReadToEndAsync();
        await process.WaitForExitAsync();
        Assert.True(process.ExitCode == 0, await stderr + await stdout);
        foreach (
            var row in JsonNode
                .Parse(await File.ReadAllTextAsync(outFile))!
                .AsArray()
                .OfType<JsonObject>()
        )
        {
            var date = new CronLocalDate(
                Stamp(row["cursor"]!),
                TimeZoneInfo.FindSystemTimeZoneById(row["zone"]!.GetValue<string>())
            );
            var operations = row["operations"]!.AsArray();
            var states = row["states"]!.AsArray();
            for (var index = 0; index < operations.Count; index++)
            {
                date.Add(Enum.Parse<CronUnit>(operations[index]!.GetValue<string>()[3..]));
                var expected = states[index]!;
                Assert.True(
                    expected["time"]!.GetValue<long>() == date.Milliseconds,
                    row["zone"]
                        + " "
                        + row["cursor"]
                        + " "
                        + operations[index]
                        + " Source="
                        + expected["time"]
                        + " C#="
                        + date.Milliseconds
                );
                var local = date.Local;
                Assert.Equal(
                    expected["local"]!.AsArray().Select(value => value!.GetValue<int>()),
                    new[]
                    {
                        local.Year,
                        local.Month,
                        local.Day,
                        local.Hour,
                        local.Minute,
                        local.Second,
                        local.Millisecond,
                    }
                );
                Assert.Equal(expected["lastDay"]!.GetValue<bool>(), date.LastDay());
                Assert.Equal(expected["lastWeekday"]!.GetValue<bool>(), date.LastWeekday());
            }
        }
    }

    [Fact]
    public void No_occurrence_step_bound_and_timespan_fail_without_hanging_or_mutating_a_successful_cursor()
    {
        var cursor = DateTimeOffset.Parse("2024-01-01T00:00:00Z").ToUnixTimeMilliseconds();
        Assert.Contains(
            "loop limit",
            Assert
                .Throws<InvalidDataException>(() =>
                    new CronSchedule("0 0 * * 1#1.5", cursor, TimeZoneInfo.Utc).Next()
                )
                .Message
        );
        Assert.Contains(
            "timespan",
            Assert
                .Throws<InvalidDataException>(() =>
                    new CronSchedule("0 0 1 2 *", cursor, TimeZoneInfo.Utc, cursor + 60_000).Next()
                )
                .Message
        );
        var schedule = new CronSchedule("*/5 * * * * *", cursor, TimeZoneInfo.Utc);
        Assert.Equal(cursor + 5_000, schedule.Next());
        Assert.Equal(cursor + 10_000, schedule.Next());
    }
}
