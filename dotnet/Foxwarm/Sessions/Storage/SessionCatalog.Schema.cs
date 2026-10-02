namespace Foxwarm.Sessions;

internal sealed partial class SessionCatalog
{
    // Exact v2 Session schema and v1 migration from the Main-owned catalog.
    private const string CreateSchemaSql = """

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
      cached_tokens INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
      recent_rank REAL GENERATED ALWAYS AS(-last_message_time) STORED,
      pinned_rank INTEGER GENERATED ALWAYS AS(CASE WHEN pinned=1 THEN 0 ELSE 1 END) VIRTUAL,
      sidebar_order_missing INTEGER GENERATED ALWAYS AS(CASE WHEN sidebar_order IS NULL THEN 1 ELSE 0 END) VIRTUAL,
      sidebar_order_value REAL GENERATED ALWAYS AS(COALESCE(sidebar_order,0)) VIRTUAL,
      presentation_root INTEGER GENERATED ALWAYS AS(CASE WHEN pinned=1 OR parent_session_id IS NULL THEN 1 ELSE 0 END) VIRTUAL
    ) STRICT;
    CREATE TABLE session_alias (
      alias TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES session_catalog(session_id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY(alias, session_id)
    ) STRICT;
    CREATE TABLE catalog_count (singleton INTEGER PRIMARY KEY CHECK(singleton=1), session_count INTEGER NOT NULL,
      busy_count INTEGER NOT NULL,queued_count INTEGER NOT NULL,managed_count INTEGER NOT NULL,
      cached_tokens INTEGER NOT NULL,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL) STRICT;
    INSERT INTO catalog_count(singleton,session_count,busy_count,queued_count,managed_count,cached_tokens,input_tokens,output_tokens)
      VALUES(1,0,0,0,0,0,0,0);
    CREATE TABLE catalog_agent_count (agent TEXT PRIMARY KEY, session_count INTEGER NOT NULL) STRICT;
    CREATE TABLE catalog_parent_count (parent_key TEXT PRIMARY KEY, session_count INTEGER NOT NULL, unpinned_session_count INTEGER NOT NULL) STRICT;
    CREATE TABLE catalog_parent_agent_count (parent_key TEXT NOT NULL,agent TEXT NOT NULL,session_count INTEGER NOT NULL,
      PRIMARY KEY(parent_key,agent)) STRICT;
    CREATE TRIGGER session_catalog_count_insert AFTER INSERT ON session_catalog BEGIN
      UPDATE catalog_count SET session_count=session_count+1,busy_count=busy_count+new.busy,
        queued_count=queued_count+CASE WHEN new.queue_length>0 THEN 1 ELSE 0 END,
        managed_count=managed_count+CASE WHEN new.managed_pending_count>0 THEN 1 ELSE 0 END,
        cached_tokens=cached_tokens+new.cached_tokens,input_tokens=input_tokens+new.input_tokens,
        output_tokens=output_tokens+new.output_tokens WHERE singleton=1;
      INSERT INTO catalog_agent_count(agent,session_count) VALUES(new.agent,1)
        ON CONFLICT(agent) DO UPDATE SET session_count=session_count+1;
      INSERT INTO catalog_parent_count(parent_key,session_count,unpinned_session_count)
        VALUES(COALESCE(new.parent_session_id,''),1,CASE WHEN new.pinned=0 THEN 1 ELSE 0 END)
        ON CONFLICT(parent_key) DO UPDATE SET session_count=session_count+1,
          unpinned_session_count=unpinned_session_count+CASE WHEN new.pinned=0 THEN 1 ELSE 0 END;
      INSERT INTO catalog_parent_agent_count(parent_key,agent,session_count) VALUES(COALESCE(new.parent_session_id,''),new.agent,1)
        ON CONFLICT(parent_key,agent) DO UPDATE SET session_count=session_count+1;
    END;
    CREATE TRIGGER session_catalog_count_delete AFTER DELETE ON session_catalog BEGIN
      UPDATE catalog_count SET session_count=session_count-1,busy_count=busy_count-old.busy,
        queued_count=queued_count-CASE WHEN old.queue_length>0 THEN 1 ELSE 0 END,
        managed_count=managed_count-CASE WHEN old.managed_pending_count>0 THEN 1 ELSE 0 END,
        cached_tokens=cached_tokens-old.cached_tokens,input_tokens=input_tokens-old.input_tokens,
        output_tokens=output_tokens-old.output_tokens WHERE singleton=1;
      UPDATE catalog_agent_count SET session_count=session_count-1 WHERE agent=old.agent;
      DELETE FROM catalog_agent_count WHERE agent=old.agent AND session_count=0;
      UPDATE catalog_parent_count SET session_count=session_count-1 WHERE parent_key=COALESCE(old.parent_session_id,'');
      UPDATE catalog_parent_count SET unpinned_session_count=unpinned_session_count-1
        WHERE parent_key=COALESCE(old.parent_session_id,'') AND old.pinned=0;
      DELETE FROM catalog_parent_count WHERE parent_key=COALESCE(old.parent_session_id,'') AND session_count=0;
      UPDATE catalog_parent_agent_count SET session_count=session_count-1
        WHERE parent_key=COALESCE(old.parent_session_id,'') AND agent=old.agent;
      DELETE FROM catalog_parent_agent_count WHERE parent_key=COALESCE(old.parent_session_id,'') AND agent=old.agent AND session_count=0;
    END;
    CREATE TRIGGER session_catalog_count_update AFTER UPDATE OF agent,parent_session_id,pinned ON session_catalog
    WHEN old.agent<>new.agent OR old.parent_session_id IS NOT new.parent_session_id OR old.pinned<>new.pinned BEGIN
      UPDATE catalog_agent_count SET session_count=session_count-1 WHERE agent=old.agent;
      DELETE FROM catalog_agent_count WHERE agent=old.agent AND session_count=0;
      INSERT INTO catalog_agent_count(agent,session_count) VALUES(new.agent,1)
        ON CONFLICT(agent) DO UPDATE SET session_count=session_count+1;
      UPDATE catalog_parent_count SET session_count=session_count-1 WHERE parent_key=COALESCE(old.parent_session_id,'');
      UPDATE catalog_parent_count SET unpinned_session_count=unpinned_session_count-1
        WHERE parent_key=COALESCE(old.parent_session_id,'') AND old.pinned=0;
      DELETE FROM catalog_parent_count WHERE parent_key=COALESCE(old.parent_session_id,'') AND session_count=0;
      INSERT INTO catalog_parent_count(parent_key,session_count,unpinned_session_count)
        VALUES(COALESCE(new.parent_session_id,''),1,CASE WHEN new.pinned=0 THEN 1 ELSE 0 END)
        ON CONFLICT(parent_key) DO UPDATE SET session_count=session_count+1,
          unpinned_session_count=unpinned_session_count+CASE WHEN new.pinned=0 THEN 1 ELSE 0 END;
      UPDATE catalog_parent_agent_count SET session_count=session_count-1
        WHERE parent_key=COALESCE(old.parent_session_id,'') AND agent=old.agent;
      DELETE FROM catalog_parent_agent_count WHERE parent_key=COALESCE(old.parent_session_id,'') AND agent=old.agent AND session_count=0;
      INSERT INTO catalog_parent_agent_count(parent_key,agent,session_count) VALUES(COALESCE(new.parent_session_id,''),new.agent,1)
        ON CONFLICT(parent_key,agent) DO UPDATE SET session_count=session_count+1;
    END;
    CREATE TRIGGER session_catalog_summary_update AFTER UPDATE OF busy,queue_length,managed_pending_count,cached_tokens,input_tokens,output_tokens ON session_catalog BEGIN
      UPDATE catalog_count SET busy_count=busy_count+new.busy-old.busy,
        queued_count=queued_count+CASE WHEN new.queue_length>0 THEN 1 ELSE 0 END-CASE WHEN old.queue_length>0 THEN 1 ELSE 0 END,
        managed_count=managed_count+CASE WHEN new.managed_pending_count>0 THEN 1 ELSE 0 END-CASE WHEN old.managed_pending_count>0 THEN 1 ELSE 0 END,
        cached_tokens=cached_tokens+new.cached_tokens-old.cached_tokens,
        input_tokens=input_tokens+new.input_tokens-old.input_tokens,
        output_tokens=output_tokens+new.output_tokens-old.output_tokens WHERE singleton=1;
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
    CREATE INDEX idx_session_catalog_root_default ON session_catalog(presentation_root,pinned_rank,archived,sidebar_order_missing,sidebar_order_value,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_root_time ON session_catalog(presentation_root,pinned_rank,archived,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_parent_default ON session_catalog(parent_session_id,pinned,archived,sidebar_order_missing,sidebar_order_value,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_parent_time ON session_catalog(parent_session_id,pinned,archived,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_agent_root_time ON session_catalog(agent,presentation_root,pinned_rank,archived,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_agent_time ON session_catalog(agent,pinned_rank,archived,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_parent_agent_default ON session_catalog(parent_session_id,agent,pinned,archived,sidebar_order_missing,sidebar_order_value,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_parent_agent_time ON session_catalog(parent_session_id,agent,pinned,archived,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_parent_agent_architecture ON session_catalog(parent_session_id,agent,archived,recent_rank,session_id);

INSERT INTO catalog_metadata(key,value) VALUES('schema_version','2');
PRAGMA user_version=2;
""";
    private const string MigrateV1Sql = """
BEGIN IMMEDIATE;
    ALTER TABLE session_catalog ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE session_catalog ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE session_catalog ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE session_catalog ADD COLUMN pinned_rank INTEGER GENERATED ALWAYS AS(CASE WHEN pinned=1 THEN 0 ELSE 1 END) VIRTUAL;
    ALTER TABLE session_catalog ADD COLUMN sidebar_order_missing INTEGER GENERATED ALWAYS AS(CASE WHEN sidebar_order IS NULL THEN 1 ELSE 0 END) VIRTUAL;
    ALTER TABLE session_catalog ADD COLUMN sidebar_order_value REAL GENERATED ALWAYS AS(COALESCE(sidebar_order,0)) VIRTUAL;
    ALTER TABLE session_catalog ADD COLUMN presentation_root INTEGER GENERATED ALWAYS AS(CASE WHEN pinned=1 OR parent_session_id IS NULL THEN 1 ELSE 0 END) VIRTUAL;
    ALTER TABLE catalog_parent_count ADD COLUMN unpinned_session_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE catalog_count ADD COLUMN busy_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE catalog_count ADD COLUMN queued_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE catalog_count ADD COLUMN managed_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE catalog_count ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE catalog_count ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE catalog_count ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE catalog_parent_agent_count (parent_key TEXT NOT NULL,agent TEXT NOT NULL,session_count INTEGER NOT NULL,
      PRIMARY KEY(parent_key,agent)) STRICT;
    UPDATE session_catalog SET
      cached_tokens=CAST(COALESCE(json_extract(metadata_json,'$.stats.totalCachedTokens'),0) AS INTEGER),
      input_tokens=CAST(COALESCE(json_extract(metadata_json,'$.stats.totalInputTokens'),0) AS INTEGER),
      output_tokens=CAST(COALESCE(json_extract(metadata_json,'$.stats.totalOutputTokens'),0) AS INTEGER);
    UPDATE catalog_parent_count SET unpinned_session_count=(SELECT count(*) FROM session_catalog
      WHERE COALESCE(parent_session_id,'')=catalog_parent_count.parent_key AND pinned=0);
    INSERT INTO catalog_parent_agent_count(parent_key,agent,session_count)
      SELECT COALESCE(parent_session_id,''),agent,count(*) FROM session_catalog GROUP BY COALESCE(parent_session_id,''),agent;
    UPDATE catalog_count SET
      busy_count=(SELECT COALESCE(sum(busy),0) FROM session_catalog),
      queued_count=(SELECT count(*) FROM session_catalog WHERE queue_length>0),
      managed_count=(SELECT count(*) FROM session_catalog WHERE managed_pending_count>0),
      cached_tokens=(SELECT COALESCE(sum(cached_tokens),0) FROM session_catalog),
      input_tokens=(SELECT COALESCE(sum(input_tokens),0) FROM session_catalog),
      output_tokens=(SELECT COALESCE(sum(output_tokens),0) FROM session_catalog) WHERE singleton=1;
    DROP TRIGGER session_catalog_count_insert;
    DROP TRIGGER session_catalog_count_delete;
    DROP TRIGGER session_catalog_count_update;
    CREATE TRIGGER session_catalog_count_insert AFTER INSERT ON session_catalog BEGIN
      UPDATE catalog_count SET session_count=session_count+1,busy_count=busy_count+new.busy,
        queued_count=queued_count+CASE WHEN new.queue_length>0 THEN 1 ELSE 0 END,
        managed_count=managed_count+CASE WHEN new.managed_pending_count>0 THEN 1 ELSE 0 END,
        cached_tokens=cached_tokens+new.cached_tokens,input_tokens=input_tokens+new.input_tokens,
        output_tokens=output_tokens+new.output_tokens WHERE singleton=1;
      INSERT INTO catalog_agent_count(agent,session_count) VALUES(new.agent,1)
        ON CONFLICT(agent) DO UPDATE SET session_count=session_count+1;
      INSERT INTO catalog_parent_count(parent_key,session_count,unpinned_session_count)
        VALUES(COALESCE(new.parent_session_id,''),1,CASE WHEN new.pinned=0 THEN 1 ELSE 0 END)
        ON CONFLICT(parent_key) DO UPDATE SET session_count=session_count+1,
          unpinned_session_count=unpinned_session_count+CASE WHEN new.pinned=0 THEN 1 ELSE 0 END;
      INSERT INTO catalog_parent_agent_count(parent_key,agent,session_count) VALUES(COALESCE(new.parent_session_id,''),new.agent,1)
        ON CONFLICT(parent_key,agent) DO UPDATE SET session_count=session_count+1;
    END;
    CREATE TRIGGER session_catalog_count_delete AFTER DELETE ON session_catalog BEGIN
      UPDATE catalog_count SET session_count=session_count-1,busy_count=busy_count-old.busy,
        queued_count=queued_count-CASE WHEN old.queue_length>0 THEN 1 ELSE 0 END,
        managed_count=managed_count-CASE WHEN old.managed_pending_count>0 THEN 1 ELSE 0 END,
        cached_tokens=cached_tokens-old.cached_tokens,input_tokens=input_tokens-old.input_tokens,
        output_tokens=output_tokens-old.output_tokens WHERE singleton=1;
      UPDATE catalog_agent_count SET session_count=session_count-1 WHERE agent=old.agent;
      DELETE FROM catalog_agent_count WHERE agent=old.agent AND session_count=0;
      UPDATE catalog_parent_count SET session_count=session_count-1,
        unpinned_session_count=unpinned_session_count-CASE WHEN old.pinned=0 THEN 1 ELSE 0 END
        WHERE parent_key=COALESCE(old.parent_session_id,'');
      DELETE FROM catalog_parent_count WHERE parent_key=COALESCE(old.parent_session_id,'') AND session_count=0;
      UPDATE catalog_parent_agent_count SET session_count=session_count-1
        WHERE parent_key=COALESCE(old.parent_session_id,'') AND agent=old.agent;
      DELETE FROM catalog_parent_agent_count WHERE parent_key=COALESCE(old.parent_session_id,'') AND agent=old.agent AND session_count=0;
    END;
    CREATE TRIGGER session_catalog_count_update AFTER UPDATE OF agent,parent_session_id,pinned ON session_catalog
    WHEN old.agent<>new.agent OR old.parent_session_id IS NOT new.parent_session_id OR old.pinned<>new.pinned BEGIN
      UPDATE catalog_agent_count SET session_count=session_count-1 WHERE agent=old.agent;
      DELETE FROM catalog_agent_count WHERE agent=old.agent AND session_count=0;
      INSERT INTO catalog_agent_count(agent,session_count) VALUES(new.agent,1)
        ON CONFLICT(agent) DO UPDATE SET session_count=session_count+1;
      UPDATE catalog_parent_count SET session_count=session_count-1,
        unpinned_session_count=unpinned_session_count-CASE WHEN old.pinned=0 THEN 1 ELSE 0 END
        WHERE parent_key=COALESCE(old.parent_session_id,'');
      DELETE FROM catalog_parent_count WHERE parent_key=COALESCE(old.parent_session_id,'') AND session_count=0;
      INSERT INTO catalog_parent_count(parent_key,session_count,unpinned_session_count)
        VALUES(COALESCE(new.parent_session_id,''),1,CASE WHEN new.pinned=0 THEN 1 ELSE 0 END)
        ON CONFLICT(parent_key) DO UPDATE SET session_count=session_count+1,
          unpinned_session_count=unpinned_session_count+CASE WHEN new.pinned=0 THEN 1 ELSE 0 END;
      UPDATE catalog_parent_agent_count SET session_count=session_count-1
        WHERE parent_key=COALESCE(old.parent_session_id,'') AND agent=old.agent;
      DELETE FROM catalog_parent_agent_count WHERE parent_key=COALESCE(old.parent_session_id,'') AND agent=old.agent AND session_count=0;
      INSERT INTO catalog_parent_agent_count(parent_key,agent,session_count) VALUES(COALESCE(new.parent_session_id,''),new.agent,1)
        ON CONFLICT(parent_key,agent) DO UPDATE SET session_count=session_count+1;
    END;
    CREATE TRIGGER session_catalog_summary_update AFTER UPDATE OF busy,queue_length,managed_pending_count,cached_tokens,input_tokens,output_tokens ON session_catalog BEGIN
      UPDATE catalog_count SET busy_count=busy_count+new.busy-old.busy,
        queued_count=queued_count+CASE WHEN new.queue_length>0 THEN 1 ELSE 0 END-CASE WHEN old.queue_length>0 THEN 1 ELSE 0 END,
        managed_count=managed_count+CASE WHEN new.managed_pending_count>0 THEN 1 ELSE 0 END-CASE WHEN old.managed_pending_count>0 THEN 1 ELSE 0 END,
        cached_tokens=cached_tokens+new.cached_tokens-old.cached_tokens,
        input_tokens=input_tokens+new.input_tokens-old.input_tokens,
        output_tokens=output_tokens+new.output_tokens-old.output_tokens WHERE singleton=1;
    END;
    CREATE INDEX idx_session_catalog_root_default ON session_catalog(presentation_root,pinned_rank,archived,sidebar_order_missing,sidebar_order_value,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_root_time ON session_catalog(presentation_root,pinned_rank,archived,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_parent_default ON session_catalog(parent_session_id,pinned,archived,sidebar_order_missing,sidebar_order_value,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_parent_time ON session_catalog(parent_session_id,pinned,archived,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_agent_root_time ON session_catalog(agent,presentation_root,pinned_rank,archived,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_agent_time ON session_catalog(agent,pinned_rank,archived,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_parent_agent_default ON session_catalog(parent_session_id,agent,pinned,archived,sidebar_order_missing,sidebar_order_value,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_parent_agent_time ON session_catalog(parent_session_id,agent,pinned,archived,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_parent_agent_architecture ON session_catalog(parent_session_id,agent,archived,recent_rank,session_id);
    UPDATE catalog_metadata SET value='2' WHERE key='schema_version';
    PRAGMA user_version=2;
    COMMIT;
""";
}
