using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed partial class SessionCatalog
{
    public DeleteSelection SelectDeletion(string requested, bool recursive)
    {
        lock (gate)
            return SessionCatalogRules.SelectDeletion(this, requested, recursive);
    }

    public void RemoveForDeletion(string id)
    {
        lock (gate)
        {
            EnsureInitialized();
            Execute(db!, "BEGIN IMMEDIATE");
            try
            {
                var old =
                    Get(id)
                    ?? throw new InvalidDataException(
                        "Deletion membership disappeared before its catalog commit."
                    );
                var references = new HashSet<string>(StringComparer.Ordinal) { id };
                foreach (var alias in old["aliases"]?.AsArray() ?? [])
                    if (Text(alias) is { } text)
                        references.Add(text);
                Execute(db!, "DELETE FROM session_catalog WHERE session_id=$p0", id);
                NormalizeParents(db!, references);
                Execute(db!, "COMMIT");
                revision++;
            }
            catch
            {
                Execute(db!, "ROLLBACK");
                throw;
            }
        }
        Changed?.Invoke();
    }
}
