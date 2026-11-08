using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Secrets;

// One installation master key outside state/. Features never use it directly: each
// derives an independent key from its purpose label, so a new consumer cannot weaken
// an existing one and copies of state/ alone do not carry decryptable secrets.
internal sealed class InstanceKeys
{
    internal const string SecretStorePurpose = "secret-store";

    // Reserved for model text-redaction placeholders (HMAC), owned by that feature.
    internal const string TextRedactionPlaceholderPurpose = "text-redaction-placeholder";

    private readonly byte[] master;

    internal string KeyId { get; }
    internal string FilePath { get; }

    private InstanceKeys(string path, string keyId, byte[] master)
    {
        FilePath = path;
        KeyId = keyId;
        this.master = master;
    }

    internal static string DefaultPath(string dataRoot) =>
        Path.Combine(Path.GetFullPath(dataRoot), "keys", "secrets.key");

    // Creates the key once (owner-only), then always reads the published file. A
    // malformed or unreadable file is an error, never a reason to generate another key.
    internal static InstanceKeys OpenOrCreate(string path)
    {
        path = Path.GetFullPath(path);
        if (!File.Exists(path))
            Create(path);
        return Read(path);
    }

    internal byte[] Derive(string purpose, int length = 32)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(purpose);
        return HKDF.DeriveKey(
            HashAlgorithmName.SHA256,
            master,
            length,
            salt: null,
            info: Encoding.UTF8.GetBytes("foxwarm/" + purpose + "/v1")
        );
    }

    private static InstanceKeys Read(string path)
    {
        JsonObject document;
        try
        {
            document =
                JsonNode.Parse(File.ReadAllText(path, Encoding.UTF8)) as JsonObject
                ?? throw new InvalidDataException("Instance key file is malformed.");
        }
        catch (System.Text.Json.JsonException error)
        {
            throw new InvalidDataException("Instance key file is malformed.", error);
        }
        if (SessionWait.Number(document["version"]) != 1)
            throw new InvalidDataException("Instance key file has an unsupported version.");
        var keyId = SessionWait.Text(document["keyId"]);
        var encoded = SessionWait.Text(document["key"]);
        byte[] key;
        try
        {
            key = Convert.FromBase64String(encoded ?? "");
        }
        catch (FormatException error)
        {
            throw new InvalidDataException("Instance key file is malformed.", error);
        }
        if (string.IsNullOrEmpty(keyId) || key.Length != 32)
            throw new InvalidDataException("Instance key file is malformed.");
        return new InstanceKeys(path, keyId, key);
    }

    private static void Create(string path)
    {
        var directory = Path.GetDirectoryName(path)!;
        if (OperatingSystem.IsWindows())
            Directory.CreateDirectory(directory);
        else
            Directory.CreateDirectory(
                directory,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            );
        var document = new JsonObject
        {
            ["version"] = 1,
            ["keyId"] = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8)),
            ["key"] = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)),
        };
        var temporary = Path.Combine(
            directory,
            "." + Path.GetFileName(path) + "." + Guid.NewGuid().ToString("N") + ".tmp"
        );
        try
        {
            var options = new FileStreamOptions
            {
                Mode = FileMode.CreateNew,
                Access = FileAccess.Write,
                Share = FileShare.None,
            };
            if (!OperatingSystem.IsWindows())
                options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            using (var stream = new FileStream(temporary, options))
            {
                stream.Write(new UTF8Encoding(false).GetBytes(document.ToJsonString() + "\n"));
                stream.Flush(true);
            }
            try
            {
                // No overwrite: a concurrent first start keeps whichever key was published first.
                File.Move(temporary, path, overwrite: false);
            }
            catch (IOException) when (File.Exists(path)) { }
            LinuxAtomicJsonFile.LinuxDirectorySync.Sync(directory);
        }
        finally
        {
            if (File.Exists(temporary))
                File.Delete(temporary);
        }
    }
}
