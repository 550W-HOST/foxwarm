namespace Foxwarm.Sessions;

/// <summary>Whole-document Session authority reads and writes through the durable file helper.</summary>
internal static class SessionAuthorityFile
{
    internal static void Write(
        this AtomicJsonFile file,
        SessionAuthorityDocument document,
        CancellationToken cancellationToken = default
    ) => file.WriteStreamPayload(document.WriteTo, cancellationToken);

    internal static SessionAuthorityDocument Read(
        this AtomicJsonFile file,
        string sessionId,
        string agent = "main"
    ) => SessionAuthorityDocument.Load(file.FilePath, sessionId, agent);
}
