using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Models;

namespace Foxwarm.Sessions;

internal sealed class ModelRetryNotice(SessionOwner hosted)
{
    private readonly RetryNoticeState state = new();
    private (string? Status, string Reason)? previous;

    internal async Task<bool> NotifyAsync(ModelRetryEvent value)
    {
        var same =
            previous is { } prior && prior.Status == value.Status && prior.Reason == value.Reason;
        var reason = same ? "(same error)" : value.Reason;
        var status = same ? null : value.Status;
        var descriptor = Clean(status is null ? reason : status + ": " + reason);
        var after = value.Final
            ? "No more retries."
            : $"Retry in {Math.Max(1, (int)Math.Ceiling((value.DelayMs ?? 0) / 1000d))} seconds...";
        var text =
            $"Attempt {value.Attempt}/{value.MaxRetries} failed{(descriptor.Length == 0 ? "." : ": " + descriptor + ".")} {after}";
        if (state.Committed is null)
            text = "⚠️ LLM Error: " + text;
        var before = state.Committed?.ToJsonString();
        var update = state.Committed is not null;
        try
        {
            await hosted.Entry.SaveLane.CommitRetryNoticeAsync(state, text, value.ToJson());
        }
        catch (Exception error)
        {
            hosted.Entry.RecordBestEffortFailure(error);
        }
        if (state.Committed is null || state.Committed.ToJsonString() == before)
            return false;
        previous = (value.Status, value.Reason);
        try
        {
            if (update)
                hosted.Emit(SessionEventKind.MessageCommitted, state.Committed);
            hosted.PublishStateChanged();
            return value.Final && (update || state.NotificationSucceeded);
        }
        catch (Exception error)
        {
            hosted.Entry.RecordBestEffortFailure(error);
            return false;
        }
    }

    private static string Clean(string value) =>
        OpenAIRequestText.Trim(
            Regex.Replace(
                value,
                "[\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+",
                " ",
                RegexOptions.CultureInvariant
            )
        );
}
