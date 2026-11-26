using System.Text;
using Foxwarm.Models;
using Foxwarm.Secrets;

namespace Foxwarm.Tests;

// File-only persistence of the text-redaction cache (`TextRedactionStore`): the store file
// itself. The backend contract cases are in TextRedactionStoreContractTests.
public sealed class TextRedactionPersistenceTests
{
    // The store holds neither originals nor placeholders in readable form, and a copy without
    // the instance key yields nothing; with the key it is readable.
    [Fact]
    public async Task A_store_copied_without_the_key_cannot_be_read()
    {
        await using var detector = await TextRedactionStoreContractTests.DetectorAsync();
        using var http = ProviderHttpRequest.CreateClient(Foxwarm.Net.EgressPolicy.Unguarded);
        using var temp = new TempDirectory();
        var options = new TextRedactionOptions(detector.Endpoint, null, 0.5, 30000)
        {
            KnownLabels = TextRedactionKnownLabels.All,
        };
        string placeholder;
        using (var secrets = TextRedactionKeys.AllLabels(temp.Path))
        {
            var scope = secrets.TextRedactor().Begin(http, options, default);
            var result = scope.MaskKnown(await scope.DetectAsync("Alice and Bob"));
            placeholder = secrets.TextRedactor().Placeholder("Alice"u8);
            Assert.Contains(placeholder, result);
        }
        var file = Path.Combine(temp.Path, "state", TextRedactionStore.FileName);
        var bytes = File.ReadAllBytes(file);
        foreach (var value in new[] { "Alice", "Bob", placeholder, TextRedactor.Prefix })
        {
            Assert.Equal(-1, bytes.AsSpan().IndexOf(Encoding.UTF8.GetBytes(value)));
            Assert.Equal(-1, bytes.AsSpan().IndexOf(Encoding.Unicode.GetBytes(value)));
        }

        using var copy = new TempDirectory();
        Directory.CreateDirectory(Path.Combine(copy.Path, "state"));
        File.Copy(file, Path.Combine(copy.Path, "state", TextRedactionStore.FileName));
        using (var foreign = TextRedactionKeys.AllLabels(copy.Path))
        {
            var redactor = foreign.TextRedactor();
            Assert.Equal(0, redactor.KnownCount);
            Assert.Null(redactor.Peek(options, "Alice and Bob"));
        }

        using var keyed = new TempDirectory();
        Directory.CreateDirectory(Path.Combine(keyed.Path, "state"));
        Directory.CreateDirectory(Path.Combine(keyed.Path, "keys"));
        File.Copy(file, Path.Combine(keyed.Path, "state", TextRedactionStore.FileName));
        File.Copy(InstanceKeys.DefaultPath(temp.Path), InstanceKeys.DefaultPath(keyed.Path));
        using (var owner = TextRedactionKeys.AllLabels(keyed.Path))
        {
            var redactor = owner.TextRedactor();
            Assert.Equal(2, redactor.KnownCount);
            Assert.NotNull(redactor.Peek(options, "Alice and Bob"));
        }
    }

    // A store that cannot be opened leaves redaction working from memory; an unreadable file
    // is replaced.
    [Fact]
    public async Task An_unusable_store_does_not_fail_redaction()
    {
        await using var detector = await TextDetectionPeer.StartAsync("Alice");
        using var http = ProviderHttpRequest.CreateClient(Foxwarm.Net.EgressPolicy.Unguarded);
        var options = new TextRedactionOptions(detector.Endpoint, null, 0.5, 30000)
        {
            KnownLabels = TextRedactionKnownLabels.All,
        };

        using var blocked = new TempDirectory();
        Directory.CreateDirectory(Path.Combine(blocked.Path, "state", TextRedactionStore.FileName));
        using (var secrets = TextRedactionKeys.AllLabels(blocked.Path))
        {
            var scope = secrets.TextRedactor().Begin(http, options, default);
            Assert.DoesNotContain("Alice", scope.MaskKnown(await scope.DetectAsync("Hi Alice")));
        }

        using var damaged = new TempDirectory();
        Directory.CreateDirectory(Path.Combine(damaged.Path, "state"));
        var file = Path.Combine(damaged.Path, "state", TextRedactionStore.FileName);
        File.WriteAllBytes(file, Enumerable.Repeat((byte)0x5A, 8192).ToArray());
        using (var secrets = TextRedactionKeys.AllLabels(damaged.Path))
        {
            var scope = secrets.TextRedactor().Begin(http, options, default);
            Assert.DoesNotContain("Alice", scope.MaskKnown(await scope.DetectAsync("Hi Alice")));
        }
        using (var secrets = TextRedactionKeys.AllLabels(damaged.Path))
            Assert.Equal(1, secrets.TextRedactor().KnownCount);
    }
}
