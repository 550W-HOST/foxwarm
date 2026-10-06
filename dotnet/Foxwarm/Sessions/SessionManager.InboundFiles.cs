namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal IDisposable BeginFileIngress(SessionOwner owner)
    {
        RequireFileIngressOwner(owner);
        return BeginOwnerMutation(owner);
    }

    internal void RequireFileIngressOwner(SessionOwner owner)
    {
        owner.Entry.RequireIdentityAuthority();
        var isolation = Isolation(owner.Agent);
        var bound = SessionGoal.Trim(isolation.RecordedNode ?? "");
        if (isolation.Isolated && bound.Length > 0 && bound != "master")
            throw new UnsupportedSessionExecutionEnvironmentException(
                "Main attachment ingress cannot use this Agent's bound Node: " + bound
            );
        if (!IsCurrentOwner(owner))
            throw new InvalidOperationException("Attachment Session owner is no longer current.");
    }
}
