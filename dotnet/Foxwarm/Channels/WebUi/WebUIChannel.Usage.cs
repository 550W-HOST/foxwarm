using System.Globalization;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Channels.WebUi;

/// <summary>
/// Administrator installation usage (System › Usage and the status bar total). The browser
/// supplies its own local period boundaries, so day and month buckets follow the viewer's time
/// zone without a server setting. Scoped browser identities are not on the route allowlist.
/// </summary>
internal sealed partial class WebUIChannel
{
    private static IResult UsageError(string message) =>
        Results.Json(
            new JsonObject { ["code"] = "USAGE_INVALID_QUERY", ["error"] = message },
            statusCode: 400
        );

    private void RegisterUsageRoutes(WebApplication app)
    {
        app.MapGet(
            "/api/usage",
            async (HttpRequest request) =>
            {
                long[] boundaries;
                string? groupBy = null;
                string? agent = null;
                var limit = 100;
                try
                {
                    foreach (var key in request.Query.Keys)
                        if (key is not ("boundaries" or "groupBy" or "agent" or "limit"))
                            throw new ArgumentException("Unknown usage query parameter.");
                    string? Single(string name) =>
                        !request.Query.TryGetValue(name, out var values) ? null
                        : values.Count == 1 ? values[0]
                        : throw new ArgumentException("Expected one " + name + " value.");
                    var parts = (Single("boundaries") ?? "").Split(',');
                    if (parts.Length < 2 || parts.Length > UsageOverview.MaxBuckets + 1)
                        throw new ArgumentException(
                            $"boundaries must list 2 to {UsageOverview.MaxBuckets + 1} times."
                        );
                    boundaries = parts
                        .Select(part =>
                            long.TryParse(
                                part,
                                NumberStyles.None,
                                CultureInfo.InvariantCulture,
                                out var value
                            )
                                ? value
                                : throw new ArgumentException(
                                    "boundaries must be epoch milliseconds."
                                )
                        )
                        .ToArray();
                    for (var index = 1; index < boundaries.Length; index++)
                        if (boundaries[index] <= boundaries[index - 1])
                            throw new ArgumentException("boundaries must increase.");
                    groupBy = Single("groupBy");
                    if (groupBy is not null && !UsageOverview.Groupings.Contains(groupBy))
                        throw new ArgumentException("Unknown usage grouping.");
                    agent = Single("agent");
                    if (agent is { Length: 0 or > 256 })
                        throw new ArgumentException("agent must name an Agent.");
                    if (Single("limit") is string text)
                        limit =
                            int.TryParse(
                                text,
                                NumberStyles.None,
                                CultureInfo.InvariantCulture,
                                out var value
                            )
                            && value is >= 1 and <= UsageOverview.MaxGroups
                                ? value
                                : throw new ArgumentException(
                                    $"limit must be 1 to {UsageOverview.MaxGroups}."
                                );
                }
                catch (ArgumentException error)
                {
                    return UsageError(error.Message);
                }
                var result = await sessions.Usage.QueryAsync(
                    boundaries,
                    groupBy,
                    agent,
                    limit,
                    request.HttpContext.RequestAborted
                );
                return Results.Json(result);
            }
        );
    }
}
