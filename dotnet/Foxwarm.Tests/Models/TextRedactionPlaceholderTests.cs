using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Secrets;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

public sealed class TextRedactionPlaceholderTests
{
    private const string Token = "[[PRIVATE_0123456789abcdef]]";
    private static readonly string Core = Token[2..^2];

    [Fact]
    public async Task Detection_clips_whole_partial_and_bare_tokens_without_registering_their_text()
    {
        var wrapped = "Alice " + Token + " Bob";
        await using var detector = await TextDetectionPeer.StartAsync(
            wrapped,
            Core,
            "3456789",
            "Alice",
            "Bob"
        );
        using var http = ProviderHttpRequest.CreateClient(Foxwarm.Net.EgressPolicy.Unguarded);
        using var redactor = new TextRedactor(
            TextRedactionTests.Key,
            knownLabels: TextRedactionKnownLabels.All
        );
        var options = new TextRedactionOptions(detector.Endpoint, null, 0.5, 30000)
        {
            KnownLabels = TextRedactionKnownLabels.All,
        };
        var input = "😀 " + wrapped + " " + Core + " [[" + Token + "]]";
        var scope = redactor.Begin(http, options, default);
        var output = await scope.RedactAsync(input);
        Assert.Contains(Token, output);
        Assert.Contains(" " + Core + " ", output);
        Assert.Contains("[[" + Token + "]]", output);
        Assert.DoesNotContain("Alice", output);
        Assert.DoesNotContain("Bob", output);
        Assert.Equal(input, scope.Restore(output));
        Assert.All(scope.Registered.Values, original => Assert.DoesNotContain(Core, original));
        var before = redactor.KnownCount;
        Assert.True(redactor.TryRegister("unused", "before " + Token + " after", ["secret"]));
        Assert.True(redactor.TryRegister("unused", Core, ["secret"]));
        Assert.Equal(before, redactor.KnownCount);

        // A previously registered substring must not literal-mask either token shape.
        Assert.True(redactor.TryRegister(redactor.Placeholder("3456789"u8), "3456789", ["secret"]));
        Assert.Empty(redactor.FindKnown(redactor.KnownSnapshot(), Token + " " + Core, options));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Polluted_known_values_are_removed_and_overlapping_stored_slots_are_redetected(
        bool literal
    )
    {
        using var temp = new TempDirectory();
        var storeKey = Enumerable.Range(0, 64).Select(index => (byte)index).ToArray();
        var path = Path.Combine(temp.Path, TextRedactionStore.FileName);
        await using var detector = await TextDetectionPeer.StartAsync(Core);
        using var http = ProviderHttpRequest.CreateClient(Foxwarm.Net.EgressPolicy.Unguarded);
        var options = new TextRedactionOptions(detector.Endpoint, null, 0.5, 30000)
        {
            KnownLabels = TextRedactionKnownLabels.All,
        };
        using var shape = new TextRedactor(TextRedactionTests.Key);
        var placeholder = shape.Placeholder(Encoding.UTF8.GetBytes(Core));
        using (var store = TextRedactionStore.Open(path, storeKey, 1 << 20)!)
        {
            store.PutKnown(placeholder, Core, ["secret"]);
            var polluted = new TextRedactor.Found(2, Core.Length, placeholder, Core, ["secret"]);
            store.PutSlot(
                options,
                TextRedactor.Digest(Token),
                literal ? [] : [polluted],
                literal ? [polluted] : []
            );
        }
        using (var store = TextRedactionStore.Open(path, storeKey, 1 << 20)!)
        using (
            var redactor = new TextRedactor(
                TextRedactionTests.Key,
                store: store,
                knownLabels: TextRedactionKnownLabels.All
            )
        )
        {
            Assert.Equal(0, redactor.KnownCount);
            Assert.Null(redactor.Peek(options, Token));
            Assert.Equal(Token, await redactor.Begin(http, options, default).RedactAsync(Token));
            store.Flush();
            Assert.Empty(store.ReadKnown());
        }
        using (var store = TextRedactionStore.Open(path, storeKey, 1 << 20)!)
        using (
            var redactor = new TextRedactor(
                TextRedactionTests.Key,
                store: store,
                knownLabels: TextRedactionKnownLabels.All
            )
        )
            Assert.Equal(Token, await redactor.Begin(http, options, default).RedactAsync(Token));
        Assert.Single(detector.Texts);
    }

    [Fact]
    public async Task Statistics_read_encrypted_known_rows_without_repair_or_writes()
    {
        using var temp = new TempDirectory();
        var keys = InstanceKeys.OpenOrCreate(InstanceKeys.DefaultPath(temp.Path));
        var path = Path.Combine(temp.Path, "state", TextRedactionStore.FileName);
        using (
            var store = TextRedactionStore.Open(
                path,
                keys.Derive(InstanceKeys.TextRedactionStorePurpose, 64),
                1 << 20
            )!
        )
        using (
            var shape = new TextRedactor(keys.Derive(InstanceKeys.TextRedactionPlaceholderPurpose))
        )
        {
            foreach (var original in new[] { "12345", "--flag", "word_name", "a@b.test", Token })
                store.PutKnown(
                    shape.Placeholder(Encoding.UTF8.GetBytes(original)),
                    original,
                    original == "a@b.test" ? ["secret", "private_email"] : ["secret", "test"]
                );
            store.Flush();
            Assert.Equal(
                5,
                TextRedactionStore.KnownStatistics(temp.Path)["count"]!.GetValue<long>()
            );
        }
        using (
            var connection = new SqliteConnection(
                new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString()
            )
        )
        {
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText =
                "INSERT INTO known(id,data,seq) VALUES(randomblob(16),randomblob(3),100)";
            command.ExecuteNonQuery();
        }
        var before = Directory
            .GetFiles(temp.Path, "*", SearchOption.AllDirectories)
            .ToDictionary(file => file, File.ReadAllBytes);
        var result = TextRedactionStore.KnownStatistics(temp.Path);
        Assert.Equal(6, result["count"]!.GetValue<long>());
        Assert.Equal(1, result["unreadable"]!.GetValue<long>());
        Assert.Equal(5, result["byLabel"]!["secret"]!.GetValue<long>());
        Assert.Equal(1, result["allDigits"]!.GetValue<long>());
        Assert.Equal(1, result["startsWithDash"]!.GetValue<long>());
        Assert.Equal(1, result["asciiIdentifiers"]!.GetValue<long>());
        Assert.Equal(1, result["containsPlaceholder"]!.GetValue<long>());
        Assert.Equal(1, result["defaultKnownLabelsEligible"]!.GetValue<long>());
        Assert.Equal(4, result["defaultKnownLabelsIneligible"]!.GetValue<long>());
        Assert.Equal(2, result["lengthUtf16"]!["4-7"]!.GetValue<long>());
        Assert.DoesNotContain(Token, result.ToJsonString());
        Assert.DoesNotContain("word_name", result.ToJsonString());
        // SQLite may create read-side WAL/SHM bookkeeping; data and the key stay intact.
        foreach (var (file, bytes) in before)
            Assert.Equal(bytes, File.ReadAllBytes(file));

        var start = new ProcessStartInfo(
            Path.Combine(Environment.GetEnvironmentVariable("DOTNET_ROOT")!, "dotnet")
        )
        {
            WorkingDirectory = temp.Path,
            ArgumentList =
            {
                Path.Combine(AppContext.BaseDirectory, "Foxwarm.DevTools.dll"),
                "text-redaction-stats",
                temp.Path,
                path,
            },
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.Environment["FOXWARM_DATA_DIR"] = temp.Path;
        using (var process = Process.Start(start)!)
        {
            var stdout = process.StandardOutput.ReadToEndAsync();
            var stderr = process.StandardError.ReadToEndAsync();
            try
            {
                await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20));
                Assert.Equal(0, process.ExitCode);
                Assert.Empty(await stderr);
                Assert.True(JsonNode.DeepEquals(result, JsonNode.Parse(await stdout)));
            }
            finally
            {
                if (!process.HasExited)
                    process.Kill(entireProcessTree: true);
            }
        }
        using var foreign = new TempDirectory();
        InstanceKeys.OpenOrCreate(InstanceKeys.DefaultPath(foreign.Path));
        Assert.Throws<InvalidDataException>(() =>
            TextRedactionStore.KnownStatistics(foreign.Path, path)
        );
        foreach (var (file, bytes) in before)
            Assert.Equal(bytes, File.ReadAllBytes(file));

        var missing = Path.Combine(temp.Path, "missing");
        Assert.ThrowsAny<IOException>(() => TextRedactionStore.KnownStatistics(missing));
        Assert.False(Directory.Exists(missing));
    }
}
