#!/usr/bin/env node
/**
 * Runs every test in test/ — the files named *.test.js — each in its own process, and fails
 * if any of them fails. They boot a PGlite database per test file (PostgreSQL with
 * SEARCH_TEST_STORE=pg), with generated RSA keys and stub subscribers on random ports; none of
 * them needs the network or a running OpenVibe.Network.
 *
 *   npm test                   # everything
 *   npm test -- publish sse    # only files whose name contains one of the words
 *   npm test -- --strict       # a skipped test fails the run too
 *
 * A test that cannot run something here prints `<label>: skipped (<why>)`: that file is listed with
 * ○ and not counted as passed (openvibe-shared/test-runner).
 */
'use strict';
// Files run side by side on PGlite (each its own database). On PostgreSQL they run one at a time: parallel migrations
// there deadlock on the migration lock and 0008's index built outside a transaction (9 deadlocks in CI, 11-15 and 11-18).
require('openvibe-shared/test-runner').main({ dir: __dirname, timeoutMs: 60000, pad: 32, ...(process.env.SEARCH_TEST_STORE === 'pg' ? { parallel: 1 } : {}) });
