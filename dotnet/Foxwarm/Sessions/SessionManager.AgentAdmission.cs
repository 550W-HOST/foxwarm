namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    // Membership-changing operations join only their affected Agents. Removal closes
    // new admission, then waits for already accepted work before taking its snapshot.
    private readonly HashSet<string> removingAgents = new(StringComparer.Ordinal);
    private readonly Dictionary<string, HashSet<TaskCompletionSource>> agentAdmissions = new(
        StringComparer.Ordinal
    );
    private readonly AsyncLocal<AgentAdmission?> agentAdmissionContext = new();

    private sealed class AgentAdmission(
        SessionManager manager,
        string[] names,
        TaskCompletionSource finished,
        AgentAdmission? prior
    ) : IDisposable
    {
        private bool active = true;

        internal bool AlreadyAccepted(string name) =>
            active && names.Contains(name, StringComparer.Ordinal)
            || prior?.AlreadyAccepted(name) == true;

        public void Dispose()
        {
            lock (manager.lifecycle)
            {
                active = false;
                if (manager.agentAdmissionContext.Value == this)
                    manager.agentAdmissionContext.Value = prior;
                foreach (var name in names)
                    if (manager.agentAdmissions.TryGetValue(name, out var pending))
                    {
                        pending.Remove(finished);
                        if (pending.Count == 0)
                            manager.agentAdmissions.Remove(name);
                    }
                finished.TrySetResult();
            }
        }
    }

    private IDisposable BeginAgentAdmission(params string[] names)
    {
        names = names.Distinct(StringComparer.Ordinal).ToArray();
        var finished = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (lifecycle)
        {
            foreach (var name in names)
                if (
                    removingAgents.Contains(name)
                    && agentAdmissionContext.Value?.AlreadyAccepted(name) != true
                )
                    throw new InvalidOperationException(
                        "Agent deletion is in progress. Retry after it finishes."
                    );
            foreach (var name in names)
            {
                if (!agentAdmissions.TryGetValue(name, out var pending))
                    agentAdmissions[name] = pending = [];
                pending.Add(finished);
            }
        }
        var scope = new AgentAdmission(this, names, finished, agentAdmissionContext.Value);
        agentAdmissionContext.Value = scope;
        return scope;
    }

    private Task[] ClaimAgentRemoval(string name)
    {
        lock (lifecycle)
        {
            if (!removingAgents.Add(name))
                throw new InvalidOperationException("Agent deletion is already in progress.");
            return agentAdmissions.TryGetValue(name, out var pending)
                ? pending.Select(done => done.Task).ToArray()
                : [];
        }
    }
}
