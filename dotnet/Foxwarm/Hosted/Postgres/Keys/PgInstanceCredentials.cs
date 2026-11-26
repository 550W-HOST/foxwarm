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

    public string? Read(InstanceCredentialName name)
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
        if (Read(name) is { } existing)
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
