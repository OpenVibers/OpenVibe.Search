-- phase: expand
-- no-transaction
-- openvibe-sdk's outbox.status().rejected reads the whole outbox for its count
-- (SELECT count(*) FROM service_outbox WHERE rejected_at IS NOT NULL): 154 ms mean on 2026-11-08.
-- A partial index holds only the rejected rows, so the same count is an index-only scan
-- over an index that is usually empty.
CREATE INDEX CONCURRENTLY IF NOT EXISTS service_outbox_rejected ON service_outbox (rejected_at) WHERE rejected_at IS NOT NULL;
