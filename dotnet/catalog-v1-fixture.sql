-- Historical source schema v1, from catalogStore at 38be7ffe.
CREATE TABLE catalog_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE session_catalog (
      session_id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      parent_reference TEXT,
      parent_session_id TEXT,
      display_name TEXT,
      archived INTEGER NOT NULL CHECK(archived IN (0,1)),
      pinned INTEGER NOT NULL CHECK(pinned IN (0,1)),
      sidebar_order REAL,
      last_message_time REAL NOT NULL,
      message_count INTEGER NOT NULL,
      busy INTEGER NOT NULL CHECK(busy IN (0,1)),
      queue_length INTEGER NOT NULL,
      managed_pending_count INTEGER NOT NULL,
      current_node TEXT NOT NULL,
      cwd TEXT,
      vector_index_position INTEGER,
      metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
      recent_rank REAL GENERATED ALWAYS AS(-last_message_time) STORED
    ) STRICT;
    CREATE TABLE session_alias (
      alias TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES session_catalog(session_id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY(alias, session_id)
    ) STRICT;
    CREATE TABLE catalog_count (singleton INTEGER PRIMARY KEY CHECK(singleton=1), session_count INTEGER NOT NULL) STRICT;
    INSERT INTO catalog_count(singleton,session_count) VALUES(1,0);
    CREATE TABLE catalog_agent_count (agent TEXT PRIMARY KEY, session_count INTEGER NOT NULL) STRICT;
    CREATE TABLE catalog_parent_count (parent_key TEXT PRIMARY KEY, session_count INTEGER NOT NULL) STRICT;
    CREATE TRIGGER session_catalog_count_insert AFTER INSERT ON session_catalog BEGIN
      UPDATE catalog_count SET session_count=session_count+1 WHERE singleton=1;
      INSERT INTO catalog_agent_count(agent,session_count) VALUES(new.agent,1)
        ON CONFLICT(agent) DO UPDATE SET session_count=session_count+1;
      INSERT INTO catalog_parent_count(parent_key,session_count) VALUES(COALESCE(new.parent_session_id,''),1)
        ON CONFLICT(parent_key) DO UPDATE SET session_count=session_count+1;
    END;
    CREATE TRIGGER session_catalog_count_delete AFTER DELETE ON session_catalog BEGIN
      UPDATE catalog_count SET session_count=session_count-1 WHERE singleton=1;
      UPDATE catalog_agent_count SET session_count=session_count-1 WHERE agent=old.agent;
      DELETE FROM catalog_agent_count WHERE agent=old.agent AND session_count=0;
      UPDATE catalog_parent_count SET session_count=session_count-1 WHERE parent_key=COALESCE(old.parent_session_id,'');
      DELETE FROM catalog_parent_count WHERE parent_key=COALESCE(old.parent_session_id,'') AND session_count=0;
    END;
    CREATE TRIGGER session_catalog_count_update AFTER UPDATE OF agent,parent_session_id ON session_catalog
    WHEN old.agent<>new.agent OR old.parent_session_id IS NOT new.parent_session_id BEGIN
      UPDATE catalog_agent_count SET session_count=session_count-1 WHERE agent=old.agent;
      DELETE FROM catalog_agent_count WHERE agent=old.agent AND session_count=0;
      INSERT INTO catalog_agent_count(agent,session_count) VALUES(new.agent,1)
        ON CONFLICT(agent) DO UPDATE SET session_count=session_count+1;
      UPDATE catalog_parent_count SET session_count=session_count-1 WHERE parent_key=COALESCE(old.parent_session_id,'');
      DELETE FROM catalog_parent_count WHERE parent_key=COALESCE(old.parent_session_id,'') AND session_count=0;
      INSERT INTO catalog_parent_count(parent_key,session_count) VALUES(COALESCE(new.parent_session_id,''),1)
        ON CONFLICT(parent_key) DO UPDATE SET session_count=session_count+1;
    END;
    CREATE INDEX idx_session_catalog_recent ON session_catalog(recent_rank, session_id);
    CREATE INDEX idx_session_catalog_agent_recent ON session_catalog(agent, recent_rank, session_id);
    CREATE INDEX idx_session_catalog_parent_recent ON session_catalog(parent_session_id, recent_rank, session_id);
    CREATE INDEX idx_session_catalog_parent_reference ON session_catalog(parent_reference, session_id);
    CREATE INDEX idx_session_catalog_current_node_recent ON session_catalog(current_node, recent_rank, session_id);
    CREATE INDEX idx_session_catalog_recovery_busy ON session_catalog(recent_rank, session_id) WHERE busy=1;
    CREATE INDEX idx_session_catalog_recovery_queued ON session_catalog(recent_rank, session_id) WHERE queue_length>0;
    CREATE INDEX idx_session_catalog_recovery_managed ON session_catalog(recent_rank, session_id) WHERE managed_pending_count>0;
    CREATE INDEX idx_session_alias_session ON session_alias(session_id, ordinal);
INSERT INTO catalog_metadata(key,value) VALUES('schema_version','1');
PRAGMA user_version=1;
