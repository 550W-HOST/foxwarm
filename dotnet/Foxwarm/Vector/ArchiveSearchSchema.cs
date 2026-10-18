namespace Foxwarm.Vector;

internal static class ArchiveSearchSchema
{
    internal const string Tables = """
        CREATE TABLE archive_search_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
        ) STRICT;
        CREATE TABLE archive_search_checkpoints (
        session_id TEXT PRIMARY KEY,
        raw_last_indexed_seq INTEGER NOT NULL DEFAULT 0,
        last_indexed_block_id INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE archive_search_documents (
        rowid INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        memory_kind TEXT NOT NULL CHECK(memory_kind IN ('raw', 'block', 'fact')),
        source_key TEXT NOT NULL,
        source_family TEXT NOT NULL,
        seq INTEGER,
        start_seq INTEGER,
        end_seq INTEGER,
        raw_start_seq INTEGER,
        raw_end_seq INTEGER,
        timestamp INTEGER,
        block_id INTEGER,
        block_level INTEGER,
        index_text TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(session_id, memory_kind, source_key)
        ) STRICT;
        CREATE INDEX idx_archive_search_documents_session_kind
        ON archive_search_documents(session_id, memory_kind);
        CREATE INDEX idx_archive_search_documents_agent
        ON archive_search_documents(agent);
        CREATE INDEX idx_archive_search_documents_block
        ON archive_search_documents(session_id, block_id);
        CREATE VIRTUAL TABLE archive_search_fts USING fts5(
        index_text,
        content='archive_search_documents',
        content_rowid='rowid',
        tokenize='trigram case_sensitive 1'
        );
        """;
    internal const string Insert = """
        CREATE TRIGGER archive_search_documents_ai AFTER INSERT ON archive_search_documents BEGIN
        INSERT INTO archive_search_fts(rowid, index_text) VALUES (new.rowid, new.index_text);
        END
        """;
    internal const string Delete = """
        CREATE TRIGGER archive_search_documents_ad AFTER DELETE ON archive_search_documents BEGIN
        INSERT INTO archive_search_fts(archive_search_fts, rowid, index_text)
        VALUES ('delete', old.rowid, old.index_text);
        END
        """;
    internal const string Update = """
        CREATE TRIGGER archive_search_documents_au AFTER UPDATE ON archive_search_documents BEGIN
        INSERT INTO archive_search_fts(archive_search_fts, rowid, index_text)
        VALUES ('delete', old.rowid, old.index_text);
        INSERT INTO archive_search_fts(rowid, index_text) VALUES (new.rowid, new.index_text);
        END
        """;
}
