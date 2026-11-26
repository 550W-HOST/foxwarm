using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using Foxwarm.Net;

namespace Foxwarm.Tests.Net;

// Guarded TLS doesn't download missing intermediate certificates: chain building would
// otherwise fetch the certificate's AIA URL over the runtime's own HTTP client, outside the
// connect callback.
public sealed class EgressTlsTests
{
    private const string Host = "tls.example";

    private sealed class Pki : IDisposable
    {
        internal X509Certificate2 Root { get; }
        internal X509Certificate2 Intermediate { get; }
        internal X509Certificate2 Leaf { get; }

        internal Pki(string aiaUrl)
        {
            using var rootKey = RSA.Create(2048);
            var rootRequest = new CertificateRequest("CN=Egress Test Root", rootKey, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            rootRequest.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
            rootRequest.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign, true));
            rootRequest.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(rootRequest.PublicKey, false));
            Root = rootRequest.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(30));

            using var intermediateKey = RSA.Create(2048);
            var intermediateRequest = new CertificateRequest("CN=Egress Test Intermediate", intermediateKey, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            intermediateRequest.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
            intermediateRequest.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign, true));
            intermediateRequest.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(intermediateRequest.PublicKey, false));
            intermediateRequest.CertificateExtensions.Add(X509AuthorityKeyIdentifierExtension.CreateFromCertificate(Root, true, false));
            using (var issued = intermediateRequest.Create(Root, DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(20), [1, 2, 3, 4]))
                Intermediate = issued.CopyWithPrivateKey(intermediateKey);

            using var leafKey = RSA.Create(2048);
            var leafRequest = new CertificateRequest("CN=" + Host, leafKey, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            var names = new SubjectAlternativeNameBuilder();
            names.AddDnsName(Host);
            leafRequest.CertificateExtensions.Add(names.Build());
            leafRequest.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, false));
            leafRequest.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension([new Oid("1.3.6.1.5.5.7.3.1")], false));
            leafRequest.CertificateExtensions.Add(X509AuthorityKeyIdentifierExtension.CreateFromCertificate(Intermediate, true, false));
            // The issuer is only reachable at this URL.
            leafRequest.CertificateExtensions.Add(new X509AuthorityInformationAccessExtension(null, [aiaUrl]));
            using (var issued = leafRequest.Create(Intermediate, DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(10), [5, 6, 7, 8]))
            {
                var withKey = issued.CopyWithPrivateKey(leafKey);
                // A key the server-side TLS stack can use on every platform.
                Leaf = X509CertificateLoader.LoadPkcs12(withKey.Export(X509ContentType.Pfx, ""), "");
                withKey.Dispose();
            }
        }

        public void Dispose()
        {
            Leaf.Dispose();
            Intermediate.Dispose();
            Root.Dispose();
        }
    }

    // Answers the AIA URL with the intermediate certificate and counts connections.
    private sealed class AiaServer : IDisposable
    {
        private readonly TcpListener listener = new(IPAddress.Loopback, 0);
        private int connections;
        internal byte[] Body = [];
        internal int Port => ((IPEndPoint)listener.LocalEndpoint).Port;
        internal int Connections => Volatile.Read(ref connections);

        internal AiaServer()
        {
            listener.Start();
            _ = AcceptAsync();
        }

        private async Task AcceptAsync()
        {
            while (true)
            {
                TcpClient client;
                try
                {
                    client = await listener.AcceptTcpClientAsync();
                }
                catch (Exception)
                {
                    return;
                }
                Interlocked.Increment(ref connections);
                _ = Task.Run(async () =>
                {
                    using (client)
                    {
                        var stream = client.GetStream();
                        await stream.ReadAsync(new byte[4096]);
                        var head = Encoding.ASCII.GetBytes(
                            $"HTTP/1.1 200 OK\r\nContent-Type: application/pkix-cert\r\nContent-Length: {Body.Length}\r\nConnection: close\r\n\r\n"
                        );
                        await stream.WriteAsync(head);
                        await stream.WriteAsync(Body);
                    }
                });
            }
        }

        public void Dispose() => listener.Stop();
    }

    // A TLS server that sends only its leaf certificate.
    private sealed class LeafOnlyServer : IDisposable
    {
        private readonly TcpListener listener = new(IPAddress.Loopback, 0);
        internal int Port => ((IPEndPoint)listener.LocalEndpoint).Port;

        internal LeafOnlyServer(X509Certificate2 leaf)
        {
            listener.Start();
            var context = SslStreamCertificateContext.Create(leaf, new X509Certificate2Collection(), offline: true);
            _ = AcceptAsync(context);
        }

        private async Task AcceptAsync(SslStreamCertificateContext context)
        {
            while (true)
            {
                TcpClient client;
                try
                {
                    client = await listener.AcceptTcpClientAsync();
                }
                catch (Exception)
                {
                    return;
                }
                _ = Task.Run(async () =>
                {
                    using (client)
                    using (var tls = new SslStream(client.GetStream()))
                    {
                        try
                        {
                            await tls.AuthenticateAsServerAsync(new SslServerAuthenticationOptions { ServerCertificateContext = context });
                            await tls.ReadAsync(new byte[4096]);
                            await tls.WriteAsync(Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"));
                        }
                        catch (Exception) { }
                    }
                });
            }
        }

        public void Dispose() => listener.Stop();
    }

    private static EgressPolicy Carried(int port) =>
        EgressPolicy.Hosted().WithTransport(
            (_, _) => Task.FromResult(new[] { EgressFixture.PublicV4 }),
            async (_, token) =>
            {
                var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
                await socket.ConnectAsync(new IPEndPoint(IPAddress.Loopback, port), token);
                return new NetworkStream(socket, ownsSocket: true);
            }
        );

    [Fact]
    public async Task AnIncompleteChainIsRefusedWithoutFetchingItsIssuer()
    {
        using var aia = new AiaServer();
        using var pki = new Pki($"http://127.0.0.1:{aia.Port}/issuer.cer");
        aia.Body = pki.Intermediate.Export(X509ContentType.Cert);
        using var server = new LeafOnlyServer(pki.Leaf);

        // Control: the runtime's default chain policy fetches the issuer from the AIA URL.
        using (
            var unguarded = new HttpClient(
                new SocketsHttpHandler
                {
                    UseProxy = false,
                    ConnectCallback = async (_, token) =>
                    {
                        var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
                        await socket.ConnectAsync(new IPEndPoint(IPAddress.Loopback, server.Port), token);
                        return new NetworkStream(socket, ownsSocket: true);
                    },
                }
            )
        )
            await Assert.ThrowsAnyAsync<HttpRequestException>(() => unguarded.GetStringAsync($"https://{Host}/"));
        var fetched = aia.Connections;
        Assert.True(fetched > 0, "the control handshake didn't fetch the AIA URL");

        var handler = (SocketsHttpHandler)EgressHttp.Handler(Carried(server.Port), EgressPurpose.Model);
        using var guarded = EgressHttp.Client(handler);
        foreach (var _ in new[] { 1, 2 })
        {
            var error = await Assert.ThrowsAnyAsync<HttpRequestException>(() => guarded.GetStringAsync($"https://{Host}/"));
            var chain = EgressCertificateException.Find(error);
            Assert.NotNull(chain);
            Assert.Equal(EgressCertificateException.Copy(Host), chain.Message);
            Assert.Equal(EgressCertificateException.Copy(Host), EgressFailure.Reason(error));
        }
        Assert.Equal(fetched, aia.Connections);
        // The shared policy isn't changed by the handshakes that used it.
        Assert.Single(handler.SslOptions.CertificateChainPolicy!.ApplicationPolicy);
    }

    [Fact]
    public void GuardedTlsKeepsTheDefaultChecksWithDownloadsDisabled()
    {
        foreach (var purpose in Enum.GetValues<EgressPurpose>())
        {
            using var handler = (SocketsHttpHandler)EgressHttp.Handler(EgressPolicy.Hosted(), purpose);
            var policy = handler.SslOptions.CertificateChainPolicy!;
            Assert.True(policy.DisableCertificateDownloads);
            Assert.Equal(X509RevocationMode.NoCheck, policy.RevocationMode);
            Assert.Equal(X509RevocationFlag.ExcludeRoot, policy.RevocationFlag);
            Assert.Equal(X509ChainTrustMode.System, policy.TrustMode);
            Assert.Equal(["1.3.6.1.5.5.7.3.1"], policy.ApplicationPolicy.Cast<Oid>().Select(oid => oid.Value));
            Assert.Equal(X509RevocationMode.NoCheck, handler.SslOptions.CertificateRevocationCheckMode);
        }
        using var pinned = (SocketsHttpHandler)EgressHttp.PinnedHandler(
            EgressPolicy.Hosted(),
            EgressPurpose.Mcp,
            Host,
            443,
            [EgressFixture.PublicV4],
            () => new InvalidOperationException(),
            () => new InvalidOperationException()
        );
        Assert.True(pinned.SslOptions.CertificateChainPolicy!.DisableCertificateDownloads);
        // File mode keeps the runtime's own TLS defaults.
        using var file = (SocketsHttpHandler)EgressHttp.Handler(EgressPolicy.Unguarded, EgressPurpose.Model);
        Assert.Null(file.SslOptions.CertificateChainPolicy);
        Assert.Null(file.SslOptions.RemoteCertificateValidationCallback);
    }

    [Fact]
    public async Task GuardedWebSocketsUseTheOfflinePolicy()
    {
        using var aia = new AiaServer();
        using var pki = new Pki($"http://127.0.0.1:{aia.Port}/issuer.cer");
        aia.Body = pki.Intermediate.Export(X509ContentType.Cert);
        using var server = new LeafOnlyServer(pki.Leaf);
        using var socket = EgressHttp.WebSocket();
        var error = await Assert.ThrowsAnyAsync<Exception>(() =>
            EgressHttp.ConnectWebSocketAsync(
                Carried(server.Port),
                EgressPurpose.Channel,
                socket,
                new Uri($"wss://{Host}/ws"),
                null,
                CancellationToken.None
            )
        );
        Assert.NotNull(EgressCertificateException.Find(error));
        Assert.Equal(0, aia.Connections);
    }
}
