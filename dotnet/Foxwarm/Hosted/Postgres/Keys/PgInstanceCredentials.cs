using System.Security.Cryptography;
using System.Text;
using Foxwarm.Secrets;
using Foxwarm.Storage;

namespace Foxwarm.Hosted.Postgres;

/// <summary>
/// <see cref="IInstanceCredentials"/> in <c>instance_credentials</c>: each credential is
/// AES-256-GCM encrypted under a key derived from the tenant's data key for this purpose, bound
/// to its name. A credential is created once (insert if absent, then read back), so every
/// replica reads the same value, and cookie and download keys derived from the HTTP token are
/// the same on each.
/// </summary>
internal sealed class PgInstanceCredentials(TenantDb database, Func<InstanceKeys> keys)
    : IInstanceCredentials
{
    private readonly CancellationTokenSource revoked = new();
    internal CancellationToken Revoked => revoked.Token;
    internal void RevokeStreams() => _ = revoked.CancelAsync();

    internal const string Purpose = "instance-credentials";
    private const int NonceBytes = 12;
    private const int TagBytes = 16;
    private static readonly UTF8Encoding Strict = new(false, true);

    internal static string Key(InstanceCredentialName name) =>
        name switch
        {
            InstanceCredentialName.HttpToken => "http-token",
            InstanceCredentialName.NodePairingToken => "node-pairing-token",
            InstanceCredentialName.NodeEventCapability => "node-event-capability",
            _ => throw new ArgumentOutOfRangeException(nameof(name)),
        };

    private long version;
    private byte[]? verifier;
    internal string? DownloadKey { get; private set; }

    // Capture once, under this runtime's grant. Redemption publishes a new verifier to
    // the same owner after commit; later owners read only its digest from this snapshot.
    internal bool CaptureVersionedHttp()
    {
        var snapshot = database.Write(tx =>
        {
            using var command = tx.Command("SELECT version, credential_hash, download_key FROM foxwarm_auth_snapshot()");
            using var reader = command.ExecuteReader();
            return reader.Read()
                ? (Version: reader.GetInt64(0), Hash: reader.IsDBNull(1) ? null : (byte[])reader[1], Key: Convert.ToHexStringLower((byte[])reader[2]))
                : default;
        });
        version = snapshot.Version;
        verifier = snapshot.Hash;
        DownloadKey = snapshot.Key;
        return version != 0;
    }

    internal bool Matches(string candidate) => Volatile.Read(ref verifier) is { } digest
        && CryptographicOperations.FixedTimeEquals(Operator.OperatorStore.Hash(candidate), digest);

    public string? Read(InstanceCredentialName name) => name == InstanceCredentialName.HttpToken && IsVersioned()
        ? null : ReadStored(name);

    private bool IsVersioned() => version != 0 || database.Read(tx =>
        tx.Scalar("SELECT credential_version FROM tenants WHERE tenant_id=$1", tx.TenantId)) is not 0L;

    // The P1 operator command may print a legacy stored token only.
    internal string? ReadLegacyHttpToken()
    {
        if (IsVersioned())
            throw new HostedBootstrapException("Use `foxwarm operator tenant rotate <slug>` to issue a new setup token.");
        return ReadStored(InstanceCredentialName.HttpToken);
    }

    private string? ReadStored(InstanceCredentialName name)
    {
        var key = Key(name);
        var row = database.Read(tx =>
        {
            using var command = tx.Command(
                "SELECT nonce, value FROM instance_credentials WHERE name = $1",
                key
            );
            using var reader = command.ExecuteReader();
            return reader.Read() ? ((byte[])reader.GetValue(0), (byte[])reader.GetValue(1)) : default;
        });
        return row.Item1 is null ? null : Decrypt(key, row.Item1, row.Item2);
    }

    public string ReadOrCreate(InstanceCredentialName name, Func<string> generate)
    {
        if (name == InstanceCredentialName.HttpToken && IsVersioned())
            throw new InvalidOperationException("A versioned access token is available only through setup exchange.");
        if (ReadStored(name) is { } existing)
            return existing;
        var key = Key(name);
        var nonce = RandomNumberGenerator.GetBytes(NonceBytes);
        var value = Encrypt(key, nonce, generate());
        database.Write(
            tx =>
                tx.Execute(
                    "INSERT INTO instance_credentials (name, nonce, value) VALUES ($1, $2, $3)"
                        + " ON CONFLICT (tenant_id, name) DO NOTHING",
                    key,
                    nonce,
                    value
                ),
            new PgWriteOptions(Verify: tx =>
                tx.Scalar("SELECT 1 FROM instance_credentials WHERE name = $1", key) is not null
            )
        );
        return Read(name)
            ?? throw new InvalidOperationException("The instance credential could not be read back.");
    }

    internal async Task<(string Status, string? AccessToken)> RedeemAsync(string submitted, CancellationToken token)
    {
        var access = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        var digest = Operator.OperatorStore.Hash(access);
        var outcome = await database.WriteAsync(async (tx, ct) =>
        {
            await using var redeem = tx.Command("SELECT foxwarm_redeem_setup($1,$2,$3)", Operator.OperatorStore.Hash(submitted), version, digest);
            return (string)(await redeem.ExecuteScalarAsync(ct))!;
        }, token: token).ConfigureAwait(false);
        if (outcome != "redeemed") return (outcome,null);
        Volatile.Write(ref verifier,digest);
        return (outcome,access);
    }

    private byte[] Encrypt(string name, byte[] nonce, string text)
    {
        var plain = Encoding.UTF8.GetBytes(text);
        var sealedValue = new byte[plain.Length + TagBytes];
        using var aes = new AesGcm(keys().Derive(Purpose), TagBytes);
        aes.Encrypt(nonce, plain, sealedValue.AsSpan(0, plain.Length), sealedValue.AsSpan(plain.Length), Aad(name));
        return sealedValue;
    }

    private string Decrypt(string name, byte[] nonce, byte[] sealedValue)
    {
        if (nonce.Length != NonceBytes || sealedValue.Length < TagBytes)
            throw new InvalidDataException("The instance credential is malformed.");
        var plain = new byte[sealedValue.Length - TagBytes];
        using var aes = new AesGcm(keys().Derive(Purpose), TagBytes);
        try
        {
            aes.Decrypt(nonce, sealedValue.AsSpan(0, plain.Length), sealedValue.AsSpan(plain.Length), plain, Aad(name));
        }
        catch (AuthenticationTagMismatchException error)
        {
            throw new InvalidDataException("The instance credential doesn't decrypt with the tenant data key.", error);
        }
        return Strict.GetString(plain);
    }

    private static byte[] Aad(string name) => Encoding.UTF8.GetBytes("foxwarm/instance-credential/v1\n" + name);
}
