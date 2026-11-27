using System.Text;
using Foxwarm.Storage;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// A read that began before an invalidation must not republish what the invalidation replaced,
// even when it completes after a newer reader has already published the new value.
public sealed class ToolAuthorizationCacheRevisionTests
{
    // Holds one read after it has taken its snapshot, until released.
    private sealed class Gate
    {
        private readonly ManualResetEventSlim entered = new();
        private readonly ManualResetEventSlim release = new();
        private int armed;

        internal void Arm() => Interlocked.Exchange(ref armed, 1);

        internal void HoldIfArmed()
        {
            if (Interlocked.Exchange(ref armed, 0) == 0)
                return;
            entered.Set();
            // A timeout here would surface as a failed read, which the authority retries; the
            // test checks TimedOut instead.
            if (!release.Wait(TimeSpan.FromSeconds(30)))
                TimedOut = true;
        }

        internal volatile bool TimedOut;

        internal void WaitEntered() => Assert.True(entered.Wait(TimeSpan.FromSeconds(30)));

        internal void Release() => release.Set();
    }

    // The tenant policy as the PostgreSQL store presents it: no direct edits, so it stays cached
    // until an invalidation.
    private sealed class GatedDocuments(IConfigDocumentStore inner, Gate gate) : IConfigDocumentStore
    {
        public string Locator(ConfigDocumentName name) => inner.Locator(name);

        public string? PhysicalPath(ConfigDocumentName name) => null;

        public bool DirectEdits => false;

        public bool Exists(ConfigDocumentName name) => inner.Exists(name);

        public byte[]? Read(ConfigDocumentName name) => inner.Read(name);

        public byte[]? ReadBounded(ConfigDocumentName name, int maxBytes)
        {
            var bytes = inner.ReadBounded(name, maxBytes);
            gate.HoldIfArmed();
            return bytes;
        }

        public Task ReplaceAsync(
            ConfigDocumentName name,
            byte[] bytes,
            CancellationToken token,
            Action<AtomicJsonWriteStage>? stage = null
        ) => inner.ReplaceAsync(name, bytes, token, stage);

        public Task<bool> TryCreateAsync(ConfigDocumentName name, byte[] bytes, CancellationToken token) =>
            inner.TryCreateAsync(name, bytes, token);
    }

    private sealed class GatedCeiling(Gate gate) : IOperatorCeilingSource
    {
        internal volatile string? Text;

        public OperatorCeilingDocument? Read()
        {
            var text = Text;
            gate.HoldIfArmed();
            return text is null ? null : new("profile:hosted", text);
        }
    }

    private static byte[] Policy(string id) =>
        Encoding.UTF8.GetBytes(
            $"version: 1\ndefaultAction: allow\nrules:\n  - id: {id}\n    tool: {{source: node, name: exec}}\n    action: deny\n"
        );

    private const string Ceiling = "version: 1\nrules:\n  - id: no-exec\n    tool: {source: node, name: exec}\n    action: deny\n";

    private static string FirstRule(ToolAuthorizationPolicy policy) =>
        policy.Value["rules"]![0]!["id"]!.GetValue<string>();

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task An_old_policy_read_completing_after_an_installation_is_not_published(bool async)
    {
        using var temp = new TempDirectory();
        var gate = new Gate();
        var authority = new ToolAuthorizationAuthority(
            new GatedDocuments(new FileConfigDocuments(temp.Path), gate)
        );
        await authority.InstallAsync(Policy("old"), CancellationToken.None);

        gate.Arm();
        var outstanding = async
            ? Task.Run(() => authority.LoadAsync())
            : Task.Run(authority.Load);
        gate.WaitEntered();
        await authority.InstallAsync(Policy("new"), CancellationToken.None);
        // A newer reader sees the installed policy first.
        Assert.Equal("new", FirstRule(async ? await authority.LoadAsync() : authority.Load()));
        gate.Release();

        // The overtaken read reads again instead of returning or caching the old policy.
        Assert.Equal("new", FirstRule(await outstanding));
        Assert.False(gate.TimedOut);
        Assert.Equal("new", FirstRule(authority.Load()));
        Assert.Equal("new", FirstRule(await authority.LoadAsync()));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task An_old_ceiling_read_completing_after_the_change_signal_is_not_published(bool async)
    {
        using var temp = new TempDirectory();
        var gate = new Gate();
        var source = new GatedCeiling(gate);
        var authority = new ToolAuthorizationAuthority(new FileConfigDocuments(temp.Path))
        {
            CeilingSource = source,
        };
        // Before the change there is no ceiling; the outstanding read sees that absence.
        gate.Arm();
        var outstanding = async
            ? Task.Run(() => authority.LoadCeilingAsync())
            : Task.Run(authority.LoadCeiling);
        gate.WaitEntered();
        source.Text = Ceiling;
        authority.OperatorCeilingChanged();
        var seen = async ? await authority.LoadCeilingAsync() : authority.LoadCeiling();
        Assert.Equal("no-exec", FirstRule(seen!));
        gate.Release();

        Assert.Equal("no-exec", FirstRule((await outstanding)!));
        Assert.False(gate.TimedOut);
        Assert.Equal("no-exec", FirstRule(authority.LoadCeiling()!));
        Assert.Equal("no-exec", FirstRule((await authority.LoadCeilingAsync())!));
    }

    [Fact]
    public async Task A_tenant_installation_also_overtakes_an_outstanding_ceiling_read()
    {
        using var temp = new TempDirectory();
        var gate = new Gate();
        var source = new GatedCeiling(gate);
        var authority = new ToolAuthorizationAuthority(new FileConfigDocuments(temp.Path))
        {
            CeilingSource = source,
        };
        gate.Arm();
        var outstanding = Task.Run(authority.LoadCeiling);
        gate.WaitEntered();
        source.Text = Ceiling;
        await authority.InstallAsync(Policy("tenant"), CancellationToken.None);
        gate.Release();
        Assert.Equal("no-exec", FirstRule((await outstanding)!));
        Assert.False(gate.TimedOut);
        Assert.Equal("no-exec", FirstRule(authority.LoadCeiling()!));
    }
}
