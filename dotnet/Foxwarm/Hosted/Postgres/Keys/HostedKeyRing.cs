using System.Security.Cryptography;
using System.Text;
using Foxwarm.Secrets;

namespace Foxwarm.Hosted.Postgres;

/// <summary>
/// The tenant's keys can't be opened without risking its data: a data key wrapped by an
/// unavailable or different key-encryption key, or encrypted data without a data key. Nothing
/// is generated in that state; hosted startup refuses (exit 78).
/// </summary>
internal sealed class TenantKeysLockedException(string message, Exception? inner = null)
    : Exception(message, inner);

/// <summary>
/// A deployment's key-encryption key (KEK). Its file has today's instance key format
/// (<c>{version, keyId, key}</c>); the wrapping key is derived from it for this one purpose.
/// </summary>
internal sealed class KeyEncryptionKey
{
    internal const string WrapPurpose = "tenant-key-wrap";
    private const int NonceBytes = 12;
    private const int TagBytes = 16;
    private readonly byte[] wrapping;

    private KeyEncryptionKey(string keyId, byte[] wrapping)
    {
        KeyId = keyId;
        this.wrapping = wrapping;
    }

    internal string KeyId { get; }

    /// <summary>Reads a KEK file; a missing, unreadable or malformed file throws.</summary>
    internal static KeyEncryptionKey Load(string path) => From(InstanceKeys.Read(Path.GetFullPath(path)));

    internal static KeyEncryptionKey From(InstanceKeys keys) => new(keys.KeyId, keys.Derive(WrapPurpose));

    internal (byte[] Nonce, byte[] Wrapped) Wrap(int tenantId, string keyId, byte[] key)
    {
        var nonce = RandomNumberGenerator.GetBytes(NonceBytes);
        var wrapped = new byte[key.Length + TagBytes];
        using var aes = new AesGcm(wrapping, TagBytes);
        aes.Encrypt(nonce, key, wrapped.AsSpan(0, key.Length), wrapped.AsSpan(key.Length), Aad(tenantId, keyId));
        return (nonce, wrapped);
    }

    /// <summary>The data key, or null when this KEK didn't wrap it (authentication fails).</summary>
    internal byte[]? Unwrap(int tenantId, string keyId, byte[] nonce, byte[] wrapped)
    {
        if (nonce.Length != NonceBytes || wrapped.Length != InstanceKeys.KeyBytes + TagBytes)
            return null;
        var key = new byte[InstanceKeys.KeyBytes];
        using var aes = new AesGcm(wrapping, TagBytes);
        try
        {
            aes.Decrypt(nonce, wrapped.AsSpan(0, key.Length), wrapped.AsSpan(key.Length), key, Aad(tenantId, keyId));
            return key;
        }
        catch (AuthenticationTagMismatchException)
        {
            return null;
        }
    }

    // Binds a wrapped key to its tenant and key ID, so a row copied to another tenant or key
    // doesn't unwrap.
    private static byte[] Aad(int tenantId, string keyId) =>
        Encoding.UTF8.GetBytes(
            "foxwarm/tenant-key/v1\n" + tenantId.ToString(System.Globalization.CultureInfo.InvariantCulture) + "\n" + keyId
        );
}

/// <summary>
/// The hosted <see cref="IKeyRing"/>: the tenant's data key (DEK) in <c>tenant_keys</c>, wrapped
/// by the current KEK. <see cref="InstanceKeys"/> is built from the DEK bytes, so every purpose
/// (secret store, text redaction, instance credentials) derives as in file mode.
/// <list type="bullet">
/// <item>Opening unwraps the DEK. A DEK still wrapped by the previous KEK is rewrapped by the
/// current one in an ordinary fenced write of this owner; that is how a KEK rotates.</item>
/// <item>Without a DEK, it creates one once (insert if absent, then read back), unless the tenant
/// already has encrypted data, which a new DEK would never decrypt.</item>
/// <item>A DEK that neither KEK unwraps is locked.</item>
/// </list>
/// The owner opens it at startup, so a locked tenant never starts.
/// </summary>
internal sealed class HostedKeyRing(
    TenantDb database,
    KeyEncryptionKey current,
    KeyEncryptionKey? previous = null
) : IKeyRing
{
    private readonly object gate = new();
    private InstanceKeys? opened;

    public string Locator => "tenant_keys";

    public bool Exists =>
        opened is not null
        || database.Read(tx => tx.Scalar("SELECT 1 FROM tenant_keys") is not null);

    /// <summary>The ID of the KEK that wraps the DEK, once opened.</summary>
    internal string? WrappedBy { get; private set; }

    public InstanceKeys OpenOrCreate()
    {
        lock (gate)
            return opened ??= Open();
    }

    private sealed record StoredKey(string KeyId, string KekId, byte[] Nonce, byte[] Wrapped);

    private InstanceKeys Open()
    {
        for (var attempt = 0; attempt < 3; attempt++)
        {
            var (stored, encrypted) = database.Read(tx =>
            {
                using var command = tx.Command(
                    "SELECT k.key_id, k.kek_id, k.nonce, k.wrapped, e.encrypted"
                        + " FROM (SELECT foxwarm_tenant_has_encrypted_data() AS encrypted) e"
                        + " LEFT JOIN tenant_keys k ON true"
                );
                using var reader = command.ExecuteReader();
                reader.Read();
                var row = reader.IsDBNull(0)
                    ? null
                    : new StoredKey(
                        reader.GetString(0),
                        reader.GetString(1),
                        (byte[])reader.GetValue(2),
                        (byte[])reader.GetValue(3)
                    );
                return (row, reader.GetBoolean(4));
            });
            if (stored is not null)
                return Unwrap(stored);
            if (encrypted)
                throw new TenantKeysLockedException(
                    "The tenant has encrypted data but no data key in tenant_keys; restore the tenant's key row. No new key was created."
                );
            Create();
        }
        throw new InvalidOperationException("The tenant data key could not be read back after its creation.");
    }

    private InstanceKeys Unwrap(StoredKey stored)
    {
        var tenant = database.TenantId;
        if (stored.KekId == current.KeyId)
        {
            var key =
                current.Unwrap(tenant, stored.KeyId, stored.Nonce, stored.Wrapped)
                ?? throw new TenantKeysLockedException(
                    $"The tenant data key doesn't unwrap with key-encryption key {stored.KekId}: FOXWARM_KEK_FILE holds a different key with the same ID."
                );
            WrappedBy = current.KeyId;
            return InstanceKeys.FromKey(stored.KeyId, key, Locator);
        }
        if (previous is not null && stored.KekId == previous.KeyId)
        {
            var key =
                previous.Unwrap(tenant, stored.KeyId, stored.Nonce, stored.Wrapped)
                ?? throw new TenantKeysLockedException(
                    $"The tenant data key doesn't unwrap with key-encryption key {stored.KekId}: FOXWARM_KEK_PREVIOUS_FILE holds a different key with the same ID."
                );
            Rewrap(stored, key);
            WrappedBy = current.KeyId;
            return InstanceKeys.FromKey(stored.KeyId, key, Locator);
        }
        throw new TenantKeysLockedException(
            $"The tenant data key is wrapped by key-encryption key {stored.KekId}, but FOXWARM_KEK_FILE holds {current.KeyId}"
                + (previous is null ? "" : $" and FOXWARM_KEK_PREVIOUS_FILE holds {previous.KeyId}")
                + "."
        );
    }

    // Compare-and-set on the row as read: the DEK itself never changes.
    private void Rewrap(StoredKey stored, byte[] key)
    {
        var (nonce, wrapped) = current.Wrap(database.TenantId, stored.KeyId, key);
        var updated = database.Write(
            tx =>
                tx.Execute(
                    "UPDATE tenant_keys SET kek_id = $1, nonce = $2, wrapped = $3"
                        + " WHERE key_id = $4 AND kek_id = $5 AND wrapped = $6",
                    current.KeyId,
                    nonce,
                    wrapped,
                    stored.KeyId,
                    stored.KekId,
                    stored.Wrapped
                ),
            new PgWriteOptions(Verify: tx =>
                tx.Scalar(
                    "SELECT 1 FROM tenant_keys WHERE key_id = $1 AND kek_id = $2 AND wrapped = $3",
                    stored.KeyId,
                    current.KeyId,
                    wrapped
                )
                    is not null
            )
        );
        if (updated != 1)
            throw new InvalidOperationException("The tenant data key changed while it was rewrapped.");
    }

    private void Create()
    {
        var keyId = InstanceKeys.NewKeyId();
        var key = RandomNumberGenerator.GetBytes(InstanceKeys.KeyBytes);
        Insert(database, current, keyId, key);
    }

    private static void Insert(TenantDb database, KeyEncryptionKey kek, string keyId, byte[] key)
    {
        var (nonce, wrapped) = kek.Wrap(database.TenantId, keyId, key);
        database.Write(
            tx =>
                tx.Execute(
                    "INSERT INTO tenant_keys (key_id, kek_id, nonce, wrapped) VALUES ($1, $2, $3, $4)"
                        + " ON CONFLICT DO NOTHING",
                    keyId,
                    kek.KeyId,
                    nonce,
                    wrapped
                ),
            new PgWriteOptions(Verify: tx =>
                tx.Scalar("SELECT 1 FROM tenant_keys WHERE key_id = $1", keyId) is not null
            )
        );
    }

    /// <summary>
    /// Import (plan C4): makes a file-mode installation's instance key the tenant's DEK, keeping
    /// its key ID, so its encrypted data imports byte for byte. Repeating it with the same key is
    /// a no-op; a tenant with a different DEK is refused.
    /// </summary>
    internal static void Adopt(TenantDb database, InstanceKeys fileKeys, KeyEncryptionKey kek)
    {
        var key = fileKeys.ExportForWrapping();
        try
        {
            Insert(database, kek, fileKeys.KeyId, key);
            var ring = new HostedKeyRing(database, kek);
            var opened = ring.OpenOrCreate();
            if (opened.KeyId != fileKeys.KeyId || !CryptographicOperations.FixedTimeEquals(opened.ExportForWrapping(), key))
                throw new InvalidOperationException(
                    $"The tenant already has data key {opened.KeyId}; the installation's key {fileKeys.KeyId} can't be adopted."
                );
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key);
        }
    }
}
