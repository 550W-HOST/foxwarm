-- Captured from the Unicode 16 writer: lexical schema 1, normalizer 1.
-- Load into an owned database to exercise the existing normalizer-mismatch rebuild.
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
CREATE TRIGGER archive_search_documents_ai AFTER INSERT ON archive_search_documents BEGIN
INSERT INTO archive_search_fts(rowid, index_text) VALUES (new.rowid, new.index_text);
END;
CREATE TRIGGER archive_search_documents_ad AFTER DELETE ON archive_search_documents BEGIN
INSERT INTO archive_search_fts(archive_search_fts, rowid, index_text)
VALUES ('delete', old.rowid, old.index_text);
END;
CREATE TRIGGER archive_search_documents_au AFTER UPDATE ON archive_search_documents BEGIN
INSERT INTO archive_search_fts(archive_search_fts, rowid, index_text)
VALUES ('delete', old.rowid, old.index_text);
INSERT INTO archive_search_fts(rowid, index_text) VALUES (new.rowid, new.index_text);
END;
INSERT INTO archive_search_metadata(key,value) VALUES('schema_version','1');
INSERT INTO archive_search_metadata(key,value) VALUES('normalizer_version','1');
INSERT INTO archive_search_metadata(key,value) VALUES('build_generation','c13c3b40-d89e-479a-a1db-b44559793d72');
INSERT INTO archive_search_checkpoints(session_id,raw_last_indexed_seq,last_indexed_block_id,updated_at) VALUES('unicode-upgrade',1,0,1792938456182);
INSERT INTO archive_search_documents(rowid,session_id,agent,memory_kind,source_key,source_family,seq,start_seq,end_seq,raw_start_seq,raw_end_seq,timestamp,block_id,block_level,index_text,content_hash,updated_at) VALUES(1,'unicode-upgrade','main','raw','1','unicode-upgrade:raw:1-1',1,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'violet αας꟎ durable ꟎꟒꟔','55ada90818f5e151daa3aedb516c339c23674f0a4be4a9a5f742a3973182a966',1792938456179);
