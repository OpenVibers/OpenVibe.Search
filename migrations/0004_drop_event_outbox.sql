-- phase: contract
-- after: 0002
-- The SDK outbox (service_outbox, migration 0002, 2026-10-10) has carried every Search event since; no code reads
-- event_outbox, and none of its rows was pending when this was written (2026-10-23).
DROP TABLE IF EXISTS event_outbox;
