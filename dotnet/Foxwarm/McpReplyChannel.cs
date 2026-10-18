using System.Text;
using Foxwarm.Channels;

namespace Foxwarm;

// A context-owned send-only text adapter. Only successful input admission retains it.
internal sealed class McpReplyChannel(
    ChannelRegistry channels,
    string contextId,
    Action available,
    Func<string, CancellationToken, Task> send
)
{
    private readonly ChannelRegistry registry = channels;
    private readonly object gate = new();
    private readonly string name = "mcp-" + contextId;
    internal string TargetId => name + ":reply";
    private int pending;
    private bool committed;
    private bool registered;
    private bool stopped;

    internal void Require()
    {
        lock (gate)
        {
            if (stopped)
                throw new McpInboundSafeException(
                    "An active Foxwarm notification receiver is required for replies."
                );
            available();
        }
    }

    internal Lease Acquire()
    {
        lock (gate)
        {
            Require();
            if (!registered)
            {
                registry.Register(name, new RegisteredChannel("mcp", (conversation, text, _, token) => SendAsync(conversation, text, token)));
                registered = true;
            }
            pending++;
            return new(this);
        }
    }

    private Task SendAsync(string conversation, string message, CancellationToken token)
    {
        lock (gate)
        {
            Require();
            if (!registered || conversation != "reply")
                throw new InvalidOperationException("MCP reply destination is unavailable.");
            if (
                Sessions.SessionGoal.Trim(message).Length == 0
                || Encoding.UTF8.GetByteCount(message) > McpClient.MaxNotificationBytes
            )
                throw new InvalidDataException("MCP reply message exceeds its limit.");
        }
        return send(message, token);
    }

    internal void Stop()
    {
        lock (gate)
        {
            stopped = true;
            registry.Unregister(name);
            registered = false;
        }
    }

    internal sealed class Lease(McpReplyChannel owner) : IDisposable
    {
        private bool released;

        internal void Commit()
        {
            lock (owner.gate)
                owner.committed = true;
        }

        public void Dispose()
        {
            lock (owner.gate)
            {
                if (released)
                    return;
                released = true;
                owner.pending--;
                if (!owner.committed && owner.pending == 0)
                {
                    owner.registry.Unregister(owner.name);
                    owner.registered = false;
                }
            }
        }
    }
}
