using Microsoft.AspNetCore.Http.Features;

namespace Foxwarm.Hosted.Forwarding;

/// <summary>Observe EOF on the upgraded public stream without interpreting tenant WebSocket frames.</summary>
internal sealed class WebSocketEnd(Action restore) : IDisposable
{
    internal static readonly TimeSpan CloseGrace = TimeSpan.FromSeconds(5);
    internal static WebSocketEnd? Observe(IFeatureCollection features, Action eof)
    {
        if (features.Get<IHttpExtendedConnectFeature>() is { IsExtendedConnect: true } connect)
        {
            features.Set<IHttpExtendedConnectFeature>(new Connect(connect, eof));
            return new(() => features.Set(connect));
        }
        if (features.Get<IHttpUpgradeFeature>() is { IsUpgradableRequest: true } upgrade)
        {
            features.Set<IHttpUpgradeFeature>(new Upgrade(upgrade, eof));
            return new(() => features.Set(upgrade));
        }
        return null;
    }

    public void Dispose() => restore();

    private sealed class Upgrade(IHttpUpgradeFeature inner, Action eof) : IHttpUpgradeFeature
    {
        public bool IsUpgradableRequest => inner.IsUpgradableRequest;
        public async Task<Stream> UpgradeAsync() => new Observed(await inner.UpgradeAsync().ConfigureAwait(false), eof);
    }

    private sealed class Connect(IHttpExtendedConnectFeature inner, Action eof) : IHttpExtendedConnectFeature
    {
        public bool IsExtendedConnect => inner.IsExtendedConnect;
        public string? Protocol => inner.Protocol;
        public async ValueTask<Stream> AcceptAsync() => new Observed(await inner.AcceptAsync().ConfigureAwait(false), eof);
    }

    private sealed class Observed(Stream inner, Action eof) : MeshDuplexStream(inner)
    {
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default)
        {
            var n = await Inner.ReadAsync(buffer, token).ConfigureAwait(false);
            if (n == 0 && buffer.Length > 0) eof();
            return n;
        }
        public override int Read(byte[] bytes, int offset, int count)
        {
            var n = Inner.Read(bytes, offset, count);
            if (n == 0 && count > 0) eof();
            return n;
        }
    }
}
