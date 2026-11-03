using System.Security.Cryptography;
using System.Text;

namespace Foxwarm.Sessions;

/// <summary>
/// Framework prompt sources. The bundled template is the live framework base; an
/// installation adds its own instructions in <see cref="LocalFileName"/>.
/// </summary>
internal static class FrameworkPrompt
{
    internal const string FileName = "00_SYSTEM.md";
    internal const string LocalFileName = "00_SYSTEM.local.md";

    internal static string TemplatePath(string resourceRoot) =>
        Path.Combine(resourceRoot, "templates", "agents", FileName);

    // Earlier releases copied the framework template into the installation once.
    // These are the SHA-256 digests (CRLF normalized to LF) of every version shipped at
    // templates/agents/00_SYSTEM.md or templates/main/memory/00_SYSTEM.md. An installed
    // copy that still matches one of them was never edited and can be removed so the
    // bundled template applies. The list is closed: newer templates are never copied.
    private static readonly HashSet<string> ReleasedCopies = new(StringComparer.Ordinal)
    {
        "063fa1a6be455baece9604de95c9aec1258d25fc3244fc685441ef743294e498",
        "113d9a9cdc35f5867bcf9b28c462859d7b3dfe9e9bc3e568aefecb6d6768380e",
        "36d248c39729d47203e932dc9c27e3a693f3b3bec6eda5e873c708987949f2bf",
        "3a9bdc7026960c70e6dc0f213b6a51f816b0b91a2a94cc302f02463211de6bfe",
        "464eea80f62fcfdc2dce56af5b6c668003a2b6bf218c0752ddce018bdb0f208e",
        "53689c5df34c5fac650fe073fd10bdcfea279af92646b755f4eb66cc83d6c56f",
        "6535085eacd76156854c80f2cd5c4feb23bbcc95207d91ff3a5a45d9492197f2",
        "683f41193e1cfd1b342690637369a881e0fe4a9c4f9848d9f45834715ac5fb65",
        "68d9de0cd874b9ad486c2cc2bc21d2a6b528e8042e98b9cd0d5530dc8ec144f8",
        "8e30211261080f12d35bcd4107dd0314c8d33b28cc319390bc42fc30e090e4a6",
        "90bbb4ae95dbd37f53aaf68ef405ee8481fd33f35327d0d663fec25805bb1574",
        "9473c5327b4ed6389097c7215737ac81b4faee35bb611452f8f1f9f53079b156",
        "9df013e6b8d9921725dd1dcfcfdba2099b08de90210b7c6687d24c70221264a1",
        "a0948d04c3c6a4acd8577fc6d83d7d3b2db446c4ecf48d379d9362ea78826529",
        "a7f959c51c648eda6941e35a1a81bab60aea7ff3673f56cfde25c4b0675d26b0",
        "ac7cdfd5f9b3891eceabf815ac0f79ec9bceb0b0174bf9c5d76cc9e9d068a9a3",
        "af02d1bd07d7045f740e6c4f845abcf444092c83d4dbb72c1d3328d6889e2e24",
        "b045d815d6e5fac86493542f71340d0007b1cd3ea1bd26fe729b6fa269c5ec68",
        "b2eb0938b8ad3e5b81e5edb7d7a99fe6dafb6c35bd2d0e624cf6692da52f9ebd",
        "b8fe2272197b88335993e91d28bee491ed1e9949e0c8162acc5a9caf57f3d7c4",
        "bacf9ce1d92df95593d92dfffd6dd013361d9f6e01dd8272a5dd9bb64d53170b",
        "c4f8b48aa652fb0750b32d2df47af34bd747366b37c392b6be11f943a1f9566b",
        "cfa634854f7ccfcd8a6fc650de18731d9024b58d8b4f2f18a04d7024ca95adb4",
        "d6942a208d82c10dca83a1b33abf8f5574eb2cc253a7f7ce7fd8a5576eca9378",
        "d8bb2cb438510e5c199e373223560608c5b45682db5683ca0d86e2056c3f7313",
        "d96b90e763eaaa4f3cf63c30c3ad444db972a1726ac2866e7ebc79e3be250cac",
        "d9e966ad1caa9f79ca3fd3088cc6b72fcdfb89ad6a15412142da70802f610da5",
        "f29fdceba00e79b4db06157ce0015ef7432303dc142909477dfd6ac0056fd2d1",
    };

    internal static bool IsUnmodifiedReleasedCopy(byte[] content)
    {
        var normalized = Encoding.UTF8.GetString(content).Replace("\r\n", "\n");
        return ReleasedCopies.Contains(
            Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(normalized)))
        );
    }
}
