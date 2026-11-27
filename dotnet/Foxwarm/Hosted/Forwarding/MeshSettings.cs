using System.Net;

namespace Foxwarm.Hosted.Forwarding;

internal sealed record MeshSettings(IPEndPoint Listen, string AdvertisedHost, byte[] Secret, int? AdvertisedPort = null)
{
    internal static MeshSettings Load(string? address, IPEndPoint listen, string? secretFile)
    {
        if (string.IsNullOrWhiteSpace(address) || !Uri.TryCreate("http://" + address, UriKind.Absolute, out var uri)
            || uri.Port is < 1 or > 65535 || uri.UserInfo.Length > 0 || uri.PathAndQuery != "/" || uri.Fragment.Length > 0
            || !address.Contains(':'))
            throw new HostedBootstrapException("FOXWARM_ADVERTISE_ADDRESS must be the host:port other replicas use for this mesh listener.");
        if (secretFile is null)
            throw new HostedBootstrapException("The runtimes host needs FOXWARM_MESH_SECRET_FILE.");
        try
        {
            var key = Convert.FromBase64String(File.ReadAllText(secretFile).Trim());
            if (key.Length != 32)
                throw new FormatException();
            return new(listen, uri.IdnHost, key, uri.Port);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or FormatException)
        {
            throw new HostedBootstrapException("FOXWARM_MESH_SECRET_FILE must contain a base64-encoded 32-byte mesh secret.");
        }
    }

    internal string Address(int boundPort) => new UriBuilder(Uri.UriSchemeHttp, AdvertisedHost, AdvertisedPort ?? boundPort).Uri.GetLeftPart(UriPartial.Authority);
}
