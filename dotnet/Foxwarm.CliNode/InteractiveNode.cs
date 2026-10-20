using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Foxwarm.CliNode;

internal sealed record InteractiveOptions(
    bool AutoApproveAll = false,
    string? Pattern = null,
    double Timeout = 0
);

// CLI presentation state only. Main remains the Session/history/admission owner.
internal sealed class InteractiveNode : IDisposable
{
    private readonly object gate = new();
    private readonly Regex? pattern;
    private readonly InteractiveOptions options;
    private NodeClient client = null!;
    private bool autoAll;
    private bool closed;
    private bool refreshing;
    private bool refreshAgain;
    private JsonArray sessions = new();
    private JsonArray history = new();
    private int selected;
    private int selectionVersion;
    private string draft = "";
    private string notice = "";
    private string status = "starting";
    private string detail = "";
    private string totalMessages = "0";
    private Pending? approval;
    private long version;

    private sealed record Pending(NodeToolCall Call, TaskCompletionSource<ToolApproval> Completion);

    internal InteractiveNode(InteractiveOptions options)
    {
        this.options = options;
        autoAll = options.AutoApproveAll;
        if (!string.IsNullOrEmpty(options.Pattern))
        {
            try
            {
                pattern = new Regex(
                    options.Pattern,
                    RegexOptions.ECMAScript
                        | RegexOptions.IgnoreCase
                        | RegexOptions.CultureInvariant
                );
            }
            catch (ArgumentException)
            {
                throw new InvalidDataException("Invalid --auto-approve regular expression");
            }
        }
    }

    internal void Attach(NodeClient value) => client = value;

    internal void Status(string state, string text)
    {
        lock (gate)
        {
            status = state;
            detail = text;
            version++;
        }
        if (state is "registered" or "pair_approved")
            Refresh();
    }

    internal async Task<ToolApproval> Intercept(NodeToolCall call, CancellationToken stop)
    {
        Pending pending;
        lock (gate)
        {
            if (closed || stop.IsCancellationRequested)
                return ToolApproval.Cancelled;
            if (autoAll || pattern?.IsMatch(call.Tool) == true)
                return ToolApproval.Approved;
            if (approval is not null)
                return ToolApproval.Busy;
            pending = new(call, new(TaskCreationOptions.RunContinuationsAsynchronously));
            approval = pending;
            version++;
        }
        var effective =
            call.TimeoutMs != 0 && !double.IsNaN(call.TimeoutMs)
                ? call.TimeoutMs
                : options.Timeout * 1000;
        try
        {
            return effective > 0
                ? await pending.Completion.Task.WaitAsync(
                    TimeSpan.FromMilliseconds(Math.Max(1000, effective - 2000)),
                    stop
                )
                : await pending.Completion.Task.WaitAsync(stop);
        }
        catch (TimeoutException)
        {
            return ToolApproval.Timeout;
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested)
        {
            return ToolApproval.Cancelled;
        }
        finally
        {
            lock (gate)
            {
                if (ReferenceEquals(approval, pending))
                {
                    approval = null;
                    version++;
                }
            }
        }
    }

    internal void Refresh()
    {
        lock (gate)
        {
            if (closed)
                return;
            if (refreshing)
            {
                refreshAgain = true;
                return;
            }
            refreshing = true;
        }
        _ = RefreshLoop();
    }

    private async Task RefreshLoop()
    {
        while (true)
        {
            lock (gate)
                refreshAgain = false;
            var connection = client.SessionConnection;
            try
            {
                await RefreshOnce(connection);
            }
            catch (Exception error) when (error is IOException or InvalidOperationException)
            {
                lock (gate)
                {
                    if (!closed && ReferenceEquals(connection, client.SessionConnection))
                    {
                        notice = "Refresh failed: " + error.Message;
                        version++;
                    }
                }
            }
            lock (gate)
            {
                if (closed || !refreshAgain)
                {
                    refreshing = false;
                    return;
                }
            }
        }
    }

    private async Task RefreshOnce(object? connection)
    {
        var next = await client.ListBoundSessions();
        string? id;
        int selection;
        lock (gate)
        {
            if (closed || !ReferenceEquals(connection, client.SessionConnection))
                return;
            var previousId = SelectedId;
            sessions = next;
            var retained = sessions
                .Select((row, index) => (row, index))
                .FirstOrDefault(item => Text(item.row, "id") == previousId);
            selected =
                previousId is not null && retained.row is not null
                    ? retained.index
                    : Math.Clamp(selected, 0, Math.Max(0, sessions.Count - 1));
            id = SelectedId;
            if (id != previousId || id is null)
                ClearHistory();
            selection = selectionVersion;
            version++;
        }
        if (id is null)
            return;
        var result = await client.GetSessionHistory(id, 30);
        lock (gate)
        {
            if (
                !closed
                && id == SelectedId
                && selection == selectionVersion
                && ReferenceEquals(connection, client.SessionConnection)
            )
            {
                history = result?["messages"] is JsonArray rows
                    ? (JsonArray)rows.DeepClone()
                    : new();
                totalMessages = result?["totalMessages"]?.ToString() ?? "0";
                notice = "Refreshed " + DateTime.Now.ToString("T", CultureInfo.CurrentCulture);
                version++;
            }
        }
    }

    private string? SelectedId => sessions.Count > selected ? Text(sessions[selected], "id") : null;

    private void ClearHistory()
    {
        history = new();
        totalMessages = "0";
        selectionVersion++;
    }

    // A batch of text is never interpreted as individual approval/send/quit shortcuts.
    internal bool Input(IReadOnlyList<ConsoleKeyInfo> keys)
    {
        string? sendTo = null;
        string? message = null;
        var refresh = false;
        lock (gate)
        {
            if (
                keys.Any(key =>
                    key.Key == ConsoleKey.C && key.Modifiers.HasFlag(ConsoleModifiers.Control)
                )
            )
                return false;
            if (keys.Count != 1)
            {
                if (approval is null)
                {
                    draft += new string(
                        keys.Where(key =>
                                key.KeyChar != '\0' && !key.Modifiers.HasFlag(ConsoleModifiers.Alt)
                            )
                            .Select(key => key.KeyChar)
                            .ToArray()
                    );
                    version++;
                }
                return true;
            }
            var key = keys[0];
            var ctrl = key.Modifiers.HasFlag(ConsoleModifiers.Control);
            if (key.KeyChar == 'q' && draft.Length == 0 && approval is null)
                return false;
            if (approval is { } pending)
            {
                if (key.KeyChar is 'a' or 'A')
                    autoAll = !autoAll;
                else if (key.KeyChar is 'y' or 'Y' || key.Key == ConsoleKey.Enter)
                    Decide(pending, ToolApproval.Approved);
                else if (key.KeyChar is 'n' or 'N' || key.Key == ConsoleKey.Escape)
                    Decide(pending, ToolApproval.Rejected);
                version++;
                return true;
            }
            if (ctrl && key.Key == ConsoleKey.R)
                refresh = true;
            else if (key.Key is ConsoleKey.UpArrow or ConsoleKey.DownArrow)
            {
                var next = Math.Clamp(
                    selected + (key.Key == ConsoleKey.UpArrow ? -1 : 1),
                    0,
                    Math.Max(0, sessions.Count - 1)
                );
                if (next != selected)
                {
                    selected = next;
                    ClearHistory();
                    refresh = true;
                }
            }
            else if (key.Key is ConsoleKey.Backspace or ConsoleKey.Delete)
            {
                var elements = StringInfo.ParseCombiningCharacters(draft);
                if (elements.Length > 0)
                    draft = draft[..elements[^1]];
            }
            else if (key.Key == ConsoleKey.Enter)
            {
                message = NodePaths.TrimSpace(draft);
                if (message.Length > 0 && SelectedId is { } id)
                {
                    sendTo = id;
                    draft = "";
                }
            }
            else if (!ctrl && !key.Modifiers.HasFlag(ConsoleModifiers.Alt) && key.KeyChar != '\0')
                draft += key.KeyChar;
            version++;
        }
        if (refresh)
            Refresh();
        if (sendTo is not null)
            _ = Send(sendTo, message!);
        return true;
    }

    private void Decide(Pending pending, ToolApproval decision)
    {
        if (!ReferenceEquals(approval, pending))
            return;
        approval = null;
        pending.Completion.TrySetResult(decision);
        notice = decision == ToolApproval.Approved ? "Tool approved" : "Tool rejected";
    }

    private async Task Send(string id, string message)
    {
        try
        {
            await client.SendSessionMessage(id, message);
            lock (gate)
            {
                notice = "Sent to " + id;
                version++;
            }
            Refresh();
        }
        catch (Exception error) when (error is IOException or InvalidOperationException)
        {
            lock (gate)
            {
                notice = "Send failed: " + error.Message;
                version++;
            }
        }
    }

    internal (long Version, IReadOnlyList<string> Lines) View(string host)
    {
        lock (gate)
        {
            var lines = new List<string>
            {
                "foxwarm cli-node " + status,
                detail,
                "host: "
                    + host
                    + "  auto: "
                    + (
                        autoAll ? "all"
                        : pattern is null ? "manual"
                        : "/" + options.Pattern + "/"
                    ),
                "Bound sessions (" + sessions.Count + ")",
            };
            var start = Math.Max(0, selected - 7);
            foreach (
                var (row, index) in sessions
                    .Select((row, index) => (row, index))
                    .Skip(start)
                    .Take(8)
            )
                lines.Add(
                    (index == selected ? "> " : "  ")
                        + Text(row, "id")
                        + " — "
                        + Text(row, "displayName")
                        + " ("
                        + (row?["messageCount"]?.ToString() ?? "0")
                        + ")"
                        + (row?["busy"]?.ToString() == "true" ? " busy" : "")
                );
            if (sessions.Count == 0)
                lines.Add("No sessions bound to this node yet");
            lines.Add("History: " + SelectedId + " (" + history.Count + "/" + totalMessages + ")");
            foreach (var row in history.TakeLast(12))
                lines.Add(
                    row?["index"]
                        + ". "
                        + Text(row, "role")
                        + ": "
                        + ConsoleNode.Text(Text(row, "text") ?? "", 500)
                );
            if (approval is { } pending)
            {
                lines.Add("Tool call pending for " + pending.Call.SessionId);
                lines.Add(
                    pending.Call.Tool
                        + " "
                        + ConsoleNode.Text(pending.Call.Args?.ToJsonString() ?? "null", 260)
                );
                lines.Add("Y/Enter approve, N/Esc reject, A toggle future auto-approval");
            }
            lines.Add((SelectedId is { } id ? "Send to " + id + ": " : "No session: ") + draft);
            lines.Add(
                notice.Length > 0
                    ? notice
                    : "Up/Down select • Enter send • Ctrl+R refresh • Ctrl+C/q quit"
            );
            return (version, lines);
        }
    }

    private static string? Text(JsonNode? row, string key) =>
        row is JsonObject obj ? NodeFileTools.Text(obj[key]) : null;

    public void Dispose()
    {
        lock (gate)
        {
            closed = true;
            if (approval is { } pending)
                Decide(pending, ToolApproval.Cancelled);
        }
    }
}
