using Foxwarm.Models;

namespace Foxwarm.Tests;

/// <summary>
/// A <see cref="ModelRequestOwner"/> with file mode's egress policy, for tests that exercise the
/// owner itself. Tests of the hosted guard build the owner with the hosted policy directly.
/// </summary>
internal static class TestModelOwners
{
    internal static ModelRequestOwner Create(
        HttpClient http,
        ResponsesClientOptions defaults,
        ModelRouting routing,
        Func<int, CancellationToken, Task>? delay = null,
        ResponsesWsTransport? websockets = null,
        Foxwarm.Images.ImageBlobStore? images = null,
        ILlmJournalStore? journal = null,
        ModelInteractionDiagnostics? diagnostics = null,
        Func<string, IReadOnlyList<int>>? retryIntervals = null,
        Foxwarm.Secrets.InstanceSecrets? secrets = null
    ) =>
        new(
            http,
            defaults,
            routing,
            Foxwarm.Net.EgressPolicy.Unguarded,
            delay,
            websockets,
            images,
            journal,
            diagnostics,
            retryIntervals,
            secrets
        );
}
