namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal string FileIngressNode(SessionOwner owner) => BoundNode(owner.Agent) ?? "master";

    internal IDisposable BeginFileIngress(SessionOwner owner)
    {
        RequireFileIngressOwner(owner);
        return BeginOwnerMutation(owner);
    }

    internal void RequireFileIngressOwner(SessionOwner owner)
    {
        owner.Entry.RequireIdentityAuthority();
        var bound = FileIngressNode(owner);
        if (bound != "master" && !Nodes.Online(bound))
            throw new InvalidOperationException(
                "Attachment Node is offline or incompatible: " + bound
            );
        if (!IsCurrentOwner(owner))
            throw new InvalidOperationException("Attachment Session owner is no longer current.");
    }
}
