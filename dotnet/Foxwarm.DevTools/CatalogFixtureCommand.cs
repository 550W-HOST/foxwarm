using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.DevTools;

internal static class CatalogFixtureCommand
{
    internal static async Task RunAsync(string[] args)
    {
        if (args.Length != 3 || args[0] is not ("upsert" or "replace"))
            throw new ArgumentException("Usage: catalog-fixture <upsert|replace> ROOT ROWS_JSON");

        var rows = JsonNode
            .Parse(await File.ReadAllTextAsync(args[2]))!
            .AsArray()
            .Select(row => row!.AsObject())
            .ToArray();
        var file = Path.Combine(args[1], "state", "catalog.sqlite");
        if (!File.Exists(file))
            CreateEmpty(file);
        using var catalog = new SessionCatalog(args[1]);
        catalog.Initialize();
        if (args[0] == "replace")
        {
            var ids = rows.Select(row => row["id"]!.GetValue<string>())
                .ToHashSet(StringComparer.Ordinal);
            foreach (var existing in catalog.List())
            {
                var id = existing["id"]!.GetValue<string>();
                if (!ids.Contains(id))
                    catalog.RemoveForDeletion(id);
            }
        }
        catalog.Upsert(rows);
    }

    // Fixture roots may already hold Session authority files that ordinary startup would refuse
    // to admit without a catalog; the fixture's rows define the membership instead.
    private static void CreateEmpty(string file)
    {
        var empty = Path.Combine(Path.GetTempPath(), "foxwarm-catalog-" + Guid.NewGuid().ToString("N"));
        try
        {
            using (var catalog = new SessionCatalog(empty))
                catalog.Initialize();
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            File.Copy(Path.Combine(empty, "state", "catalog.sqlite"), file);
        }
        finally
        {
            Directory.Delete(empty, true);
        }
    }
}
