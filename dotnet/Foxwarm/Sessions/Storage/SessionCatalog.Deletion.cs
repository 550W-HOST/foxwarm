using System.Text.Json.Nodes;
using System.Globalization;

namespace Foxwarm.Sessions;

internal sealed partial class SessionCatalog
{
    internal DeleteSelection SelectDeletion(string requested, bool recursive)
    {
        lock (gate)
        {
            var root = Text(RequiredMain(requested)["id"])!;
            if (recursive) { var tree = DescendantsLocked(root); return new(root, [root, .. tree.Descendants], tree.Direct, tree.PostOrder); }
            var direct = Rows($"SELECT {Columns} FROM session_catalog ORDER BY session_id")
                .Where(row => Text(row["parentSessionId"]) is { } raw && Text(Resolve(raw)["sessionId"]) == root)
                .Select(row => Text(row["id"])!).OrderBy(id => id, Comparer<string>.Create((a, b) => SidebarCollation.Compare(a, b, CompareOptions.None))).ToArray();
            return new(root, [root], direct, [root]);
        }
    }
    internal void RemoveForDeletion(string id)
    {
        lock (gate)
        {
            EnsureInitialized(); Execute(db!, "BEGIN IMMEDIATE");
            try
            {
                var old = Get(id) ?? throw new InvalidDataException("Deletion membership disappeared before its catalog commit.");
                var references = new HashSet<string>(StringComparer.Ordinal) { id };
                foreach (var alias in old["aliases"]?.AsArray() ?? []) if (Text(alias) is { } text) references.Add(text);
                Execute(db!, "DELETE FROM session_catalog WHERE session_id=$p0", id); NormalizeParents(db!, references);
                Execute(db!, "COMMIT"); revision++;
            }
            catch { Execute(db!, "ROLLBACK"); throw; }
        }
        Changed?.Invoke();
    }
}
