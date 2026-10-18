using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Channels;

internal sealed class WeWorkCrypto(string token, string encodingAesKey)
{
    private readonly byte[] key = Key(encodingAesKey);

    private static byte[] Key(string value)
    {
        value = value.Trim();
        return Convert.FromBase64String(value.PadRight((value.Length + 3) / 4 * 4, '='));
    }

    private static byte[] Decrypt(byte[] bytes, byte[] key)
    {
        using var aes = Aes.Create();
        aes.Key = key;
        var decrypted = aes.DecryptCbc(bytes, key.AsSpan(0, 16), PaddingMode.None);
        var pad = decrypted.Length == 0 ? 0 : decrypted[^1];
        return pad is >= 1 and <= 32 ? decrypted[..Math.Max(0, decrypted.Length - pad)] : decrypted;
    }

    internal static byte[] DecryptResource(byte[] bytes, string key) => Decrypt(bytes, Key(key));

    internal byte[] DecryptAttachment(byte[] bytes) => Decrypt(bytes, key);

    internal string DecryptCallback(string encrypted)
    {
        var decrypted = Decrypt(Convert.FromBase64String(encrypted), key);
        var length = BinaryPrimitives.ReadUInt32BigEndian(decrypted.AsSpan(16, 4));
        // Source extracts only the declared content and ignores the trailing receive ID.
        return Encoding.UTF8.GetString(
            decrypted.AsSpan(20, (int)Math.Min(length, Math.Max(0, decrypted.Length - 20)))
        );
    }

    internal string Sign(string timestamp, string nonce, string encrypted)
    {
        var values = new[] { token, timestamp, nonce, encrypted };
        Array.Sort(values, StringComparer.Ordinal);
        return Convert.ToHexStringLower(
            SHA1.HashData(Encoding.UTF8.GetBytes(string.Concat(values)))
        );
    }

    internal bool Verify(string? signature, string timestamp, string nonce, string encrypted) =>
        !string.IsNullOrEmpty(signature) && Sign(timestamp, nonce, encrypted) == signature;

    internal JsonObject EncryptCallback(
        string plaintext,
        string timestamp,
        string nonce,
        string receiveId = ""
    )
    {
        var content = Encoding.UTF8.GetBytes(plaintext);
        var receiver = Encoding.UTF8.GetBytes(receiveId);
        var length = 20 + content.Length + receiver.Length;
        var pad = 32 - length % 32;
        var raw = new byte[length + pad];
        RandomNumberGenerator.Fill(raw.AsSpan(0, 16));
        BinaryPrimitives.WriteUInt32BigEndian(raw.AsSpan(16, 4), (uint)content.Length);
        content.CopyTo(raw, 20);
        receiver.CopyTo(raw, 20 + content.Length);
        raw.AsSpan(length).Fill((byte)pad);
        using var aes = Aes.Create();
        aes.Key = key;
        var encrypted = Convert.ToBase64String(
            aes.EncryptCbc(raw, key.AsSpan(0, 16), PaddingMode.None)
        );
        return new JsonObject
        {
            ["encrypt"] = encrypted,
            ["msgsignature"] = Sign(timestamp, nonce, encrypted),
            ["timestamp"] =
                double.TryParse(
                    timestamp,
                    System.Globalization.CultureInfo.InvariantCulture,
                    out var numeric
                ) && double.IsFinite(numeric)
                    ? JsonValue.Create(numeric)
                    : null,
            ["nonce"] = nonce,
        };
    }
}
