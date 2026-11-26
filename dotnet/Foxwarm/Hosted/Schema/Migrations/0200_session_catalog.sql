-- reader-floor: 1
-- Session catalog (ISessionCatalogStore): the file catalog's schema version 3 with its additive
-- grouping and activity objects, per tenant. Text keys and ordered text use byte order ("C")
-- like SQLite's BINARY collation. Booleans stay 0/1 integers because they are sort keys. The
-- JSON fields the SQLite queries read with json_extract are extracted into columns at write.

CREATE TABLE session_catalog (
    tenant_id integer NOT NULL,
    session_id text COLLATE "C" NOT NULL,
    agent text COLLATE "C" NOT NULL,
    parent_reference text COLLATE "C",
    parent_session_id text COLLATE "C",
    display_name text COLLATE "C",
    archived bigint NOT NULL CHECK (archived IN (0, 1)),
    pinned bigint NOT NULL CHECK (pinned IN (0, 1)),
    sidebar_order double precision,
    last_message_time double precision NOT NULL,
    message_count bigint NOT NULL,
    busy bigint NOT NULL CHECK (busy IN (0, 1)),
    queue_length bigint NOT NULL,
    managed_pending_count bigint NOT NULL,
    current_node text COLLATE "C" NOT NULL,
    cwd text COLLATE "C",
    vector_index_position bigint,
    cached_tokens bigint NOT NULL,
    input_tokens bigint NOT NULL,
    output_tokens bigint NOT NULL,
    cost double precision,
    metadata_json text COLLATE "C" NOT NULL CHECK (pg_input_is_valid(metadata_json, 'json')),
    -- meta.questions.open, meta.questions.approvals, and whether meta.wait.id is a string.
    question_open double precision,
    question_approvals double precision,
    wait_present boolean NOT NULL,
    -- Newest own last_message_time of the row and its real descendants (triggers below).
    subtree_time double precision NOT NULL DEFAULT 0,
    recent_rank double precision GENERATED ALWAYS AS (-last_message_time) STORED,
    pinned_rank bigint GENERATED ALWAYS AS (CASE WHEN pinned = 1 THEN 0 ELSE 1 END) STORED,
    sidebar_order_missing bigint GENERATED ALWAYS AS (CASE WHEN sidebar_order IS NULL THEN 1 ELSE 0 END) STORED,
    sidebar_order_value double precision GENERATED ALWAYS AS (COALESCE(sidebar_order, 0)) STORED,
    presentation_root bigint GENERATED ALWAYS AS (CASE WHEN pinned = 1 OR parent_session_id IS NULL THEN 1 ELSE 0 END) STORED,
    subtree_rank double precision GENERATED ALWAYS AS (-subtree_time) STORED,
    PRIMARY KEY (tenant_id, session_id)
);
SELECT foxwarm_tenant_table('session_catalog', 'SELECT, INSERT, UPDATE, DELETE');

CREATE TABLE session_alias (
    tenant_id integer NOT NULL,
    alias text COLLATE "C" NOT NULL,
    session_id text COLLATE "C" NOT NULL,
    ordinal bigint NOT NULL,
    PRIMARY KEY (tenant_id, alias, session_id),
    FOREIGN KEY (tenant_id, session_id) REFERENCES session_catalog (tenant_id, session_id) ON DELETE CASCADE
);
SELECT foxwarm_tenant_table('session_alias', 'SELECT, INSERT, UPDATE, DELETE');

-- Maintained counts. The file catalog's singleton row is one row per tenant, created by the
-- first insert.
CREATE TABLE catalog_count (
    tenant_id integer NOT NULL,
    session_count bigint NOT NULL,
    busy_count bigint NOT NULL,
    queued_count bigint NOT NULL,
    managed_count bigint NOT NULL,
    cached_tokens bigint NOT NULL,
    input_tokens bigint NOT NULL,
    output_tokens bigint NOT NULL,
    cost double precision NOT NULL,
    cost_count bigint NOT NULL,
    positive_cost_count bigint NOT NULL,
    PRIMARY KEY (tenant_id)
);
SELECT foxwarm_tenant_table('catalog_count', 'SELECT, INSERT, UPDATE, DELETE');

CREATE TABLE catalog_agent_count (
    tenant_id integer NOT NULL,
    agent text COLLATE "C" NOT NULL,
    session_count bigint NOT NULL,
    PRIMARY KEY (tenant_id, agent)
);
SELECT foxwarm_tenant_table('catalog_agent_count', 'SELECT, INSERT, UPDATE, DELETE');

CREATE TABLE catalog_parent_count (
    tenant_id integer NOT NULL,
    parent_key text COLLATE "C" NOT NULL,
    session_count bigint NOT NULL,
    unpinned_session_count bigint NOT NULL,
    PRIMARY KEY (tenant_id, parent_key)
);
SELECT foxwarm_tenant_table('catalog_parent_count', 'SELECT, INSERT, UPDATE, DELETE');

CREATE TABLE catalog_parent_agent_count (
    tenant_id integer NOT NULL,
    parent_key text COLLATE "C" NOT NULL,
    agent text COLLATE "C" NOT NULL,
    session_count bigint NOT NULL,
    PRIMARY KEY (tenant_id, parent_key, agent)
);
SELECT foxwarm_tenant_table('catalog_parent_agent_count', 'SELECT, INSERT, UPDATE, DELETE');

CREATE TABLE catalog_node_count (
    tenant_id integer NOT NULL,
    current_node text COLLATE "C" NOT NULL,
    session_count bigint NOT NULL,
    root_count bigint NOT NULL,
    PRIMARY KEY (tenant_id, current_node)
);
SELECT foxwarm_tenant_table('catalog_node_count', 'SELECT, INSERT, UPDATE, DELETE');

-- Raised by every catalog write transaction; list cursors bind it.
CREATE TABLE catalog_revision (
    tenant_id integer NOT NULL,
    revision bigint NOT NULL,
    PRIMARY KEY (tenant_id)
);
SELECT foxwarm_tenant_table('catalog_revision', 'SELECT, INSERT, UPDATE');

-- The file catalog's indexes, each after tenant_id. The SQLite queries that name an index with
-- INDEXED BY rely on these; the catalog's EXPLAIN tests check the plans.
CREATE INDEX idx_session_catalog_recent ON session_catalog (tenant_id, recent_rank, session_id);
CREATE INDEX idx_session_catalog_agent_recent ON session_catalog (tenant_id, agent, recent_rank, session_id);
CREATE INDEX idx_session_catalog_parent_recent ON session_catalog (tenant_id, parent_session_id, recent_rank, session_id);
CREATE INDEX idx_session_catalog_parent_reference ON session_catalog (tenant_id, parent_reference, session_id);
CREATE INDEX idx_session_catalog_current_node_recent ON session_catalog (tenant_id, current_node, recent_rank, session_id);
CREATE INDEX idx_session_catalog_recovery_busy ON session_catalog (tenant_id, recent_rank, session_id) WHERE busy = 1;
CREATE INDEX idx_session_catalog_recovery_queued ON session_catalog (tenant_id, recent_rank, session_id) WHERE queue_length > 0;
CREATE INDEX idx_session_catalog_recovery_managed ON session_catalog (tenant_id, recent_rank, session_id) WHERE managed_pending_count > 0;
CREATE INDEX idx_session_alias_session ON session_alias (tenant_id, session_id, ordinal);
CREATE INDEX idx_session_catalog_root_default ON session_catalog (tenant_id, presentation_root, pinned_rank, archived, sidebar_order_missing, sidebar_order_value, recent_rank, session_id);
CREATE INDEX idx_session_catalog_root_time ON session_catalog (tenant_id, presentation_root, pinned_rank, archived, recent_rank, session_id);
CREATE INDEX idx_session_catalog_parent_default ON session_catalog (tenant_id, parent_session_id, pinned, archived, sidebar_order_missing, sidebar_order_value, recent_rank, session_id);
CREATE INDEX idx_session_catalog_parent_time ON session_catalog (tenant_id, parent_session_id, pinned, archived, recent_rank, session_id);
CREATE INDEX idx_session_catalog_agent_root_time ON session_catalog (tenant_id, agent, presentation_root, pinned_rank, archived, recent_rank, session_id);
CREATE INDEX idx_session_catalog_agent_time ON session_catalog (tenant_id, agent, pinned_rank, archived, recent_rank, session_id);
CREATE INDEX idx_session_catalog_parent_agent_default ON session_catalog (tenant_id, parent_session_id, agent, pinned, archived, sidebar_order_missing, sidebar_order_value, recent_rank, session_id);
CREATE INDEX idx_session_catalog_parent_agent_time ON session_catalog (tenant_id, parent_session_id, agent, pinned, archived, recent_rank, session_id);
CREATE INDEX idx_session_catalog_parent_agent_architecture ON session_catalog (tenant_id, parent_session_id, agent, archived, recent_rank, session_id);
CREATE INDEX idx_session_catalog_wait_presence ON session_catalog (tenant_id, session_id) WHERE wait_present;
CREATE INDEX idx_session_catalog_question_presence ON session_catalog (tenant_id, recent_rank, session_id) WHERE question_open > 0;
CREATE INDEX idx_session_catalog_node_time ON session_catalog (tenant_id, current_node, archived, recent_rank, session_id) WHERE pinned = 0;
CREATE INDEX idx_session_catalog_parent_subtree ON session_catalog (tenant_id, parent_session_id, subtree_time, session_id);
CREATE INDEX idx_session_catalog_root_activity ON session_catalog (tenant_id, presentation_root, pinned_rank, archived, subtree_rank, session_id);
CREATE INDEX idx_session_catalog_root_activity_default ON session_catalog (tenant_id, presentation_root, pinned_rank, archived, sidebar_order_missing, sidebar_order_value, subtree_rank, session_id);
CREATE INDEX idx_session_catalog_parent_activity ON session_catalog (tenant_id, parent_session_id, pinned, archived, subtree_rank, session_id);
CREATE INDEX idx_session_catalog_parent_activity_default ON session_catalog (tenant_id, parent_session_id, pinned, archived, sidebar_order_missing, sidebar_order_value, subtree_rank, session_id);
CREATE INDEX idx_session_catalog_agent_root_activity ON session_catalog (tenant_id, agent, archived, subtree_rank, session_id) WHERE parent_session_id IS NULL AND pinned = 0;
CREATE INDEX idx_session_catalog_agent_root_activity_default ON session_catalog (tenant_id, agent, archived, sidebar_order_missing, sidebar_order_value, subtree_rank, session_id) WHERE parent_session_id IS NULL AND pinned = 0;
CREATE INDEX idx_session_catalog_node_root_activity ON session_catalog (tenant_id, current_node, archived, subtree_rank, session_id) WHERE parent_session_id IS NULL AND pinned = 0;
CREATE INDEX idx_session_catalog_node_root_activity_default ON session_catalog (tenant_id, current_node, archived, sidebar_order_missing, sidebar_order_value, subtree_rank, session_id) WHERE parent_session_id IS NULL AND pinned = 0;

-- Recomputes the ancestor chain starting at `start` (inclusive), like the file catalog's
-- RefreshSubtreeSql: each member's value is the running maximum, from the start upward, of its
-- own time and the values of its children outside the chain. The trail only stops tolerated
-- legacy cycles from looping.
CREATE FUNCTION session_catalog_refresh_subtree(start text) RETURNS void
LANGUAGE sql SET search_path FROM CURRENT AS $$
UPDATE session_catalog SET subtree_time = run.v
  FROM (
    WITH RECURSIVE chain(id, parent, child, depth, trail) AS (
        SELECT session_id, parent_session_id, NULL::text COLLATE "C", 0, ARRAY[session_id]
          FROM session_catalog WHERE session_id = start
        UNION ALL
        SELECT p.session_id, p.parent_session_id, chain.id, chain.depth + 1, chain.trail || p.session_id
          FROM chain JOIN session_catalog p ON p.session_id = chain.parent
         WHERE p.session_id <> ALL (chain.trail)),
    own(id, depth, v) AS (
        SELECT chain.id, chain.depth, GREATEST(a.last_message_time, COALESCE(
                 (SELECT k.subtree_time FROM session_catalog k
                   WHERE k.parent_session_id = chain.id AND k.session_id IS DISTINCT FROM chain.child
                   ORDER BY k.subtree_time DESC LIMIT 1), a.last_message_time))
          FROM chain JOIN session_catalog a ON a.session_id = chain.id)
    SELECT id, max(v) OVER (ORDER BY depth) AS v FROM own
  ) run
 WHERE session_catalog.session_id = run.id;
$$;

-- The file catalog's eleven count triggers (count, summary, cost and Node counts) and its three
-- subtree triggers, as one function per row event. Each branch keeps the SQLite expression,
-- including the order of floating-point cost arithmetic. A branch runs exactly when the
-- SQLite trigger's columns and WHEN condition select it; skipping a zero-delta update is
-- equivalent.
CREATE FUNCTION session_catalog_after_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
    INSERT INTO catalog_count AS c (tenant_id, session_count, busy_count, queued_count, managed_count,
                                    cached_tokens, input_tokens, output_tokens, cost, cost_count, positive_cost_count)
    VALUES (NEW.tenant_id, 1, NEW.busy,
            CASE WHEN NEW.queue_length > 0 THEN 1 ELSE 0 END,
            CASE WHEN NEW.managed_pending_count > 0 THEN 1 ELSE 0 END,
            NEW.cached_tokens, NEW.input_tokens, NEW.output_tokens,
            0 + COALESCE(NEW.cost, 0),
            CASE WHEN NEW.cost IS NULL THEN 0 ELSE 1 END,
            CASE WHEN NEW.cost > 0 THEN 1 ELSE 0 END)
    ON CONFLICT (tenant_id) DO UPDATE SET
        session_count = c.session_count + 1,
        busy_count = c.busy_count + NEW.busy,
        queued_count = c.queued_count + CASE WHEN NEW.queue_length > 0 THEN 1 ELSE 0 END,
        managed_count = c.managed_count + CASE WHEN NEW.managed_pending_count > 0 THEN 1 ELSE 0 END,
        cached_tokens = c.cached_tokens + NEW.cached_tokens,
        input_tokens = c.input_tokens + NEW.input_tokens,
        output_tokens = c.output_tokens + NEW.output_tokens,
        cost = c.cost + COALESCE(NEW.cost, 0),
        positive_cost_count = c.positive_cost_count + CASE WHEN NEW.cost > 0 THEN 1 ELSE 0 END,
        cost_count = c.cost_count + CASE WHEN NEW.cost IS NULL THEN 0 ELSE 1 END;
    INSERT INTO catalog_agent_count AS c (tenant_id, agent, session_count) VALUES (NEW.tenant_id, NEW.agent, 1)
        ON CONFLICT (tenant_id, agent) DO UPDATE SET session_count = c.session_count + 1;
    INSERT INTO catalog_parent_count AS c (tenant_id, parent_key, session_count, unpinned_session_count)
        VALUES (NEW.tenant_id, COALESCE(NEW.parent_session_id, ''), 1, CASE WHEN NEW.pinned = 0 THEN 1 ELSE 0 END)
        ON CONFLICT (tenant_id, parent_key) DO UPDATE SET session_count = c.session_count + 1,
            unpinned_session_count = c.unpinned_session_count + CASE WHEN NEW.pinned = 0 THEN 1 ELSE 0 END;
    INSERT INTO catalog_parent_agent_count AS c (tenant_id, parent_key, agent, session_count)
        VALUES (NEW.tenant_id, COALESCE(NEW.parent_session_id, ''), NEW.agent, 1)
        ON CONFLICT (tenant_id, parent_key, agent) DO UPDATE SET session_count = c.session_count + 1;
    INSERT INTO catalog_node_count AS c (tenant_id, current_node, session_count, root_count)
        VALUES (NEW.tenant_id, NEW.current_node, 1, CASE WHEN NEW.parent_session_id IS NULL THEN 1 ELSE 0 END)
        ON CONFLICT (tenant_id, current_node) DO UPDATE SET session_count = c.session_count + 1,
            root_count = c.root_count + CASE WHEN NEW.parent_session_id IS NULL THEN 1 ELSE 0 END;
    PERFORM session_catalog_refresh_subtree(NEW.session_id);
    RETURN NULL;
END
$$;

CREATE FUNCTION session_catalog_after_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
    old_parent text := COALESCE(OLD.parent_session_id, '');
BEGIN
    UPDATE catalog_count SET
        session_count = session_count - 1,
        busy_count = busy_count - OLD.busy,
        queued_count = queued_count - CASE WHEN OLD.queue_length > 0 THEN 1 ELSE 0 END,
        managed_count = managed_count - CASE WHEN OLD.managed_pending_count > 0 THEN 1 ELSE 0 END,
        cached_tokens = cached_tokens - OLD.cached_tokens,
        input_tokens = input_tokens - OLD.input_tokens,
        output_tokens = output_tokens - OLD.output_tokens,
        cost = CASE WHEN positive_cost_count = CASE WHEN OLD.cost > 0 THEN 1 ELSE 0 END THEN 0
                    ELSE cost - COALESCE(OLD.cost, 0) END,
        positive_cost_count = positive_cost_count - CASE WHEN OLD.cost > 0 THEN 1 ELSE 0 END,
        cost_count = cost_count - CASE WHEN OLD.cost IS NULL THEN 0 ELSE 1 END
     WHERE tenant_id = OLD.tenant_id;
    UPDATE catalog_agent_count SET session_count = session_count - 1
     WHERE tenant_id = OLD.tenant_id AND agent = OLD.agent;
    DELETE FROM catalog_agent_count WHERE tenant_id = OLD.tenant_id AND agent = OLD.agent AND session_count = 0;
    UPDATE catalog_parent_count SET session_count = session_count - 1,
           unpinned_session_count = unpinned_session_count - CASE WHEN OLD.pinned = 0 THEN 1 ELSE 0 END
     WHERE tenant_id = OLD.tenant_id AND parent_key = old_parent;
    DELETE FROM catalog_parent_count WHERE tenant_id = OLD.tenant_id AND parent_key = old_parent AND session_count = 0;
    UPDATE catalog_parent_agent_count SET session_count = session_count - 1
     WHERE tenant_id = OLD.tenant_id AND parent_key = old_parent AND agent = OLD.agent;
    DELETE FROM catalog_parent_agent_count
     WHERE tenant_id = OLD.tenant_id AND parent_key = old_parent AND agent = OLD.agent AND session_count = 0;
    UPDATE catalog_node_count SET session_count = session_count - 1,
           root_count = root_count - CASE WHEN OLD.parent_session_id IS NULL THEN 1 ELSE 0 END
     WHERE tenant_id = OLD.tenant_id AND current_node = OLD.current_node;
    DELETE FROM catalog_node_count WHERE tenant_id = OLD.tenant_id AND current_node = OLD.current_node AND session_count = 0;
    PERFORM session_catalog_refresh_subtree(OLD.parent_session_id);
    RETURN NULL;
END
$$;

-- The subtree refresh's own update writes only subtree_time, which selects no branch.
CREATE FUNCTION session_catalog_after_update() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
    old_parent text := COALESCE(OLD.parent_session_id, '');
    new_parent text := COALESCE(NEW.parent_session_id, '');
BEGIN
    IF OLD.agent <> NEW.agent OR OLD.parent_session_id IS DISTINCT FROM NEW.parent_session_id
       OR OLD.pinned <> NEW.pinned THEN
        UPDATE catalog_agent_count SET session_count = session_count - 1
         WHERE tenant_id = OLD.tenant_id AND agent = OLD.agent;
        DELETE FROM catalog_agent_count WHERE tenant_id = OLD.tenant_id AND agent = OLD.agent AND session_count = 0;
        INSERT INTO catalog_agent_count AS c (tenant_id, agent, session_count) VALUES (NEW.tenant_id, NEW.agent, 1)
            ON CONFLICT (tenant_id, agent) DO UPDATE SET session_count = c.session_count + 1;
        UPDATE catalog_parent_count SET session_count = session_count - 1,
               unpinned_session_count = unpinned_session_count - CASE WHEN OLD.pinned = 0 THEN 1 ELSE 0 END
         WHERE tenant_id = OLD.tenant_id AND parent_key = old_parent;
        DELETE FROM catalog_parent_count WHERE tenant_id = OLD.tenant_id AND parent_key = old_parent AND session_count = 0;
        INSERT INTO catalog_parent_count AS c (tenant_id, parent_key, session_count, unpinned_session_count)
            VALUES (NEW.tenant_id, new_parent, 1, CASE WHEN NEW.pinned = 0 THEN 1 ELSE 0 END)
            ON CONFLICT (tenant_id, parent_key) DO UPDATE SET session_count = c.session_count + 1,
                unpinned_session_count = c.unpinned_session_count + CASE WHEN NEW.pinned = 0 THEN 1 ELSE 0 END;
        UPDATE catalog_parent_agent_count SET session_count = session_count - 1
         WHERE tenant_id = OLD.tenant_id AND parent_key = old_parent AND agent = OLD.agent;
        DELETE FROM catalog_parent_agent_count
         WHERE tenant_id = OLD.tenant_id AND parent_key = old_parent AND agent = OLD.agent AND session_count = 0;
        INSERT INTO catalog_parent_agent_count AS c (tenant_id, parent_key, agent, session_count)
            VALUES (NEW.tenant_id, new_parent, NEW.agent, 1)
            ON CONFLICT (tenant_id, parent_key, agent) DO UPDATE SET session_count = c.session_count + 1;
    END IF;
    IF OLD.busy <> NEW.busy OR OLD.queue_length <> NEW.queue_length
       OR OLD.managed_pending_count <> NEW.managed_pending_count OR OLD.cached_tokens <> NEW.cached_tokens
       OR OLD.input_tokens <> NEW.input_tokens OR OLD.output_tokens <> NEW.output_tokens THEN
        UPDATE catalog_count SET
            busy_count = busy_count + NEW.busy - OLD.busy,
            queued_count = queued_count + CASE WHEN NEW.queue_length > 0 THEN 1 ELSE 0 END
                           - CASE WHEN OLD.queue_length > 0 THEN 1 ELSE 0 END,
            managed_count = managed_count + CASE WHEN NEW.managed_pending_count > 0 THEN 1 ELSE 0 END
                            - CASE WHEN OLD.managed_pending_count > 0 THEN 1 ELSE 0 END,
            cached_tokens = cached_tokens + NEW.cached_tokens - OLD.cached_tokens,
            input_tokens = input_tokens + NEW.input_tokens - OLD.input_tokens,
            output_tokens = output_tokens + NEW.output_tokens - OLD.output_tokens
         WHERE tenant_id = NEW.tenant_id;
    END IF;
    IF OLD.cost IS DISTINCT FROM NEW.cost THEN
        UPDATE catalog_count SET
            cost = CASE WHEN positive_cost_count + CASE WHEN NEW.cost > 0 THEN 1 ELSE 0 END
                             - CASE WHEN OLD.cost > 0 THEN 1 ELSE 0 END = 0 THEN 0
                        ELSE cost + (COALESCE(NEW.cost, 0) - COALESCE(OLD.cost, 0)) END,
            positive_cost_count = positive_cost_count + CASE WHEN NEW.cost > 0 THEN 1 ELSE 0 END
                                  - CASE WHEN OLD.cost > 0 THEN 1 ELSE 0 END,
            cost_count = cost_count + CASE WHEN NEW.cost IS NULL THEN 0 ELSE 1 END
                         - CASE WHEN OLD.cost IS NULL THEN 0 ELSE 1 END
         WHERE tenant_id = NEW.tenant_id;
    END IF;
    IF OLD.current_node <> NEW.current_node
       OR (OLD.parent_session_id IS NULL) <> (NEW.parent_session_id IS NULL) THEN
        UPDATE catalog_node_count SET session_count = session_count - 1,
               root_count = root_count - CASE WHEN OLD.parent_session_id IS NULL THEN 1 ELSE 0 END
         WHERE tenant_id = OLD.tenant_id AND current_node = OLD.current_node;
        DELETE FROM catalog_node_count WHERE tenant_id = OLD.tenant_id AND current_node = OLD.current_node AND session_count = 0;
        INSERT INTO catalog_node_count AS c (tenant_id, current_node, session_count, root_count)
            VALUES (NEW.tenant_id, NEW.current_node, 1, CASE WHEN NEW.parent_session_id IS NULL THEN 1 ELSE 0 END)
            ON CONFLICT (tenant_id, current_node) DO UPDATE SET session_count = c.session_count + 1,
                root_count = c.root_count + CASE WHEN NEW.parent_session_id IS NULL THEN 1 ELSE 0 END;
    END IF;
    IF OLD.last_message_time <> NEW.last_message_time
       OR OLD.parent_session_id IS DISTINCT FROM NEW.parent_session_id THEN
        PERFORM session_catalog_refresh_subtree(NEW.session_id);
        IF OLD.parent_session_id IS DISTINCT FROM NEW.parent_session_id THEN
            PERFORM session_catalog_refresh_subtree(OLD.parent_session_id);
        END IF;
    END IF;
    RETURN NULL;
END
$$;

CREATE TRIGGER session_catalog_after_insert AFTER INSERT ON session_catalog
    FOR EACH ROW EXECUTE FUNCTION session_catalog_after_insert();
CREATE TRIGGER session_catalog_after_delete AFTER DELETE ON session_catalog
    FOR EACH ROW EXECUTE FUNCTION session_catalog_after_delete();
CREATE TRIGGER session_catalog_after_update AFTER UPDATE ON session_catalog
    FOR EACH ROW EXECUTE FUNCTION session_catalog_after_update();
