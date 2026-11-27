using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Limits;

/// <summary>
/// The tenant's request rate and open WebSockets at owner admission (plan P2 §7.2): the first
/// middleware after WebSocket negotiation in the tenant's own pipeline, so every route counts,
/// whichever replica's front or edge forwarded the request. Over the rate, a request is answered
/// 429 with <c>Retry-After</c>; one WebSocket over the limit is refused the same way before it
/// is accepted.
/// </summary>
internal static class RequestLimits
{
    internal static async Task InvokeAsync(HttpContext context, TenantAdmission admission, Func<Task> next)
    {
        if (!admission.Requests.TryTake(out var retryAfter))
        {
            await RefuseAsync(
                context,
                retryAfter,
                "Too many requests. Try again in a moment."
            );
            return;
        }
        if (!context.WebSockets.IsWebSocketRequest)
        {
            await next();
            return;
        }
        using var socket = admission.WebSockets.TryOpen();
        if (socket is null)
        {
            await RefuseAsync(
                context,
                TimeSpan.FromSeconds(5),
                "Too many open connections. Close a tab or another client and try again."
            );
            return;
        }
        // The lease ends with the request, which an accepted WebSocket keeps open.
        await next();
    }

    private static Task RefuseAsync(HttpContext context, TimeSpan retryAfter, string error)
    {
        context.Response.StatusCode = StatusCodes.Status429TooManyRequests;
        context.Response.Headers.RetryAfter = Math.Max(1, (int)Math.Ceiling(retryAfter.TotalSeconds)).ToString(
            System.Globalization.CultureInfo.InvariantCulture
        );
        context.Response.ContentType = "application/json";
        return context.Response.WriteAsync(new JsonObject { ["error"] = error }.ToJsonString());
    }
}
