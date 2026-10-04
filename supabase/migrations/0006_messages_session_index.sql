-- Goal2 load test finding: history() filtered messages by session_id with no index, so every turn ran a
-- (parallel) sequential scan over all messages. Cost grew with total history, and under concurrency the
-- parallel workers exhausted the container's 64MB /dev/shm (SQLSTATE 53100). Index the per-session read.
BEGIN;
CREATE INDEX IF NOT EXISTS messages_session_ordinal ON messages(session_id, ordinal);
INSERT INTO ptr_schema_migrations(name) VALUES ('0006_messages_session_index.sql') ON CONFLICT DO NOTHING;
COMMIT;
