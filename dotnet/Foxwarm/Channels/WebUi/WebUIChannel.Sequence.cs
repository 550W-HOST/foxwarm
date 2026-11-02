using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Channels.WebUi;

internal sealed partial class WebUIChannel
{
    // Process-local key: opaque peer labels are stable while Main runs and do not reveal IDs.
    private static readonly byte[] OpaquePeerKey = RandomNumberGenerator.GetBytes(32);

    internal static string OpaquePeer(string sessionId) =>
        "external:"
        + Convert
            .ToHexString(HMACSHA256.HashData(OpaquePeerKey, Encoding.UTF8.GetBytes(sessionId)))[
                ..16
            ]
            .ToLowerInvariant();

    private void RegisterSequenceRoutes(WebApplication app)
    {
        app.MapPost(
            "/api/session-sequence",
            async (HttpRequest request) =>
                await ListBody(
                    request,
                    body =>
                    {
                        SessionListQueries.Keys(
                            body.Select(pair => pair.Key),
                            "before",
                            "limit",
                            "after",
                            "since",
                            "eventLimit",
                            "sessionIds"
                        );
                        static SessionListQueryException Invalid(string message) =>
                            new("SESSION_SEQUENCE_INVALID", message);
                        var ids = body.ContainsKey("sessionIds")
                            ? SessionListQueries.Ids(
                                body["sessionIds"],
                                SessionSequenceProjection.MaxSessionIds
                            )
                            : null;
                        Dictionary<string, long>? after = null;
                        if (body.ContainsKey("after"))
                        {
                            if (
                                body["after"] is not JsonObject cursors
                                || cursors.Count > SessionSequenceProjection.MaxSessionIds
                            )
                                throw Invalid("after must map Session IDs to sequence numbers.");
                            after = new(StringComparer.Ordinal);
                            foreach (var (id, node) in cursors)
                            {
                                if (
                                    id.Length is < 1 or > 512
                                    || SessionCatalog.Number(node) is not { } seq
                                    || seq < 0
                                    || Math.Truncate(seq) != seq
                                )
                                    throw Invalid("after must map Session IDs to sequence numbers.");
                                after[id] = (long)seq;
                            }
                        }
                        double? since = null;
                        if (body.ContainsKey("since"))
                            since =
                                SessionCatalog.Number(body["since"]) is { } value && value >= 0
                                    ? value
                                    : throw Invalid("since must be a nonnegative time in milliseconds.");
                        if (after is not null != since is not null)
                            throw Invalid("after and since are used together, for live updates.");
                        ArchiveSequenceCursor? before = null;
                        if (body.ContainsKey("before") && body["before"] is not null)
                        {
                            if (after is not null)
                                throw Invalid("before pages older rows and cannot be combined with after.");
                            before =
                                body["before"] is JsonObject cursor
                                && cursor.All(pair => pair.Key is "at" or "sessionId" or "seq")
                                && SessionCatalog.Number(cursor["at"]) is { } at
                                && at >= 0
                                && (cursor["sessionId"] is null) == (cursor["seq"] is null)
                                && (
                                    cursor["sessionId"] is null
                                    || SessionCatalog.Text(cursor["sessionId"]) is { Length: >= 1 and <= 512 }
                                        && SessionCatalog.Number(cursor["seq"]) is { } tie
                                        && tie >= 0
                                        && Math.Truncate(tie) == tie
                                )
                                    ? new(
                                        at,
                                        SessionCatalog.Text(cursor["sessionId"]),
                                        SessionCatalog.Number(cursor["seq"]) is { } n ? (long)n : null
                                    )
                                    : throw Invalid("before must be a cursor returned as next.");
                        }
                        var scoped = WebUiAccess.Request(request);
                        scoped?.Require();
                        var visibility = scoped is null
                            ? null
                            : new SessionSequenceProjection.Visibility(
                                scoped.Allows,
                                OpaquePeer,
                                scoped.Session
                            );
                        var projection = new SessionSequenceProjection(
                            runtime,
                            sessions.ArchiveDatabase
                        );
                        var result = after is not null
                            ? projection.BuildIncremental(
                                new(
                                    since!.Value,
                                    after,
                                    BodyLimit(
                                        body,
                                        "eventLimit",
                                        SessionSequenceProjection.DefaultEventLimit,
                                        SessionSequenceProjection.MaxEventLimit
                                    ),
                                    ids
                                ),
                                visibility
                            )
                            : projection.BuildPage(
                                new(
                                    before,
                                    BodyLimit(
                                        body,
                                        "limit",
                                        SessionSequenceProjection.DefaultPageLimit,
                                        SessionSequenceProjection.MaxPageLimit
                                    ),
                                    ids
                                ),
                                visibility
                            );
                        // Scope can change while the projection reads; never return stale scope.
                        scoped?.Require();
                        return result;
                    }
                )
        );
    }
}
