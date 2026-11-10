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
        if (!IsCurrentOwner(owner))
            throw new InvalidOperationException("Attachment Session owner is no longer current.");
    }
}
