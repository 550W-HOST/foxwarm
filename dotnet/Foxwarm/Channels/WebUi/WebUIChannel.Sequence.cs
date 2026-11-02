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
                            "since",
                            "focusSessionId",
                            "sessionIds",
                            "after",
                            "sessionLimit",
                            "eventLimit"
                        );
                        var since =
                            SessionCatalog.Number(body["since"]) is { } value && value >= 0
                                ? value
                                : throw new SessionListQueryException(
                                    "SESSION_SEQUENCE_INVALID",
                                    "since must be a nonnegative time in milliseconds."
                                );
                        var focus = BodyText(body, "focusSessionId");
                        if (focus is { Length: < 1 or > 512 })
                            throw new SessionListQueryException(
                                "SESSION_SEQUENCE_INVALID",
                                "focusSessionId is invalid."
                            );
                        var ids = body.ContainsKey("sessionIds")
                            ? SessionListQueries.Ids(
                                body["sessionIds"],
                                SessionSequenceProjection.MaxSessionLimit
                            )
                            : null;
                        Dictionary<string, long>? after = null;
                        if (body.ContainsKey("after"))
                        {
                            if (
                                body["after"] is not JsonObject cursors
                                || cursors.Count > SessionSequenceProjection.MaxSessionLimit
                            )
                                throw new SessionListQueryException(
                                    "SESSION_SEQUENCE_INVALID",
                                    "after must map Session IDs to sequence numbers."
                                );
                            after = new(StringComparer.Ordinal);
                            foreach (var (id, node) in cursors)
                            {
                                if (
                                    id.Length is < 1 or > 512
                                    || SessionCatalog.Number(node) is not { } seq
                                    || seq < 0
                                    || Math.Truncate(seq) != seq
                                )
                                    throw new SessionListQueryException(
                                        "SESSION_SEQUENCE_INVALID",
                                        "after must map Session IDs to sequence numbers."
                                    );
                                after[id] = (long)seq;
                            }
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
                        var result = new SessionSequenceProjection(
                            runtime,
                            sessions.ArchiveDatabase
                        ).Build(
                            new(
                                since,
                                focus,
                                ids,
                                after,
                                BodyLimit(
                                    body,
                                    "sessionLimit",
                                    SessionSequenceProjection.DefaultSessionLimit,
                                    SessionSequenceProjection.MaxSessionLimit
                                ),
                                BodyLimit(
                                    body,
                                    "eventLimit",
                                    SessionSequenceProjection.DefaultEventLimit,
                                    SessionSequenceProjection.MaxEventLimit
                                )
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
