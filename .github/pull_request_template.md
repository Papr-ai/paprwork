## Ticket
Ticket: #

## What changed and why


## How I tested it


## Impact
Write "none" if it doesn't apply. Give numbers where you have them.
- **Database reads/writes:** queries added or changed per request or per job run; any loops that run one query per item (N+1); indexes used (`EXPLAIN QUERY PLAN` for new SQLite queries); write volume and transaction size; sync or replica load.
- **Speed:** is this on a hot path (startup, chat send, scheduler tick, app load, sync flush)? Before/after timing for anything on one.
- **Memory and payload size:** new caches, large reads into memory, response or bundle size.
- **Security:** new inputs, endpoints, permissions, tokens or secrets; who can reach it; is input checked; does anything new get logged.
- **Data:** schema or migration changes; any chance of loss or corruption; works with existing data.
- **Rollback:** how to undo it (revert is enough, or needs a data fix).

## Risk
- [ ] Touches sync, database schema/migrations, auth, or CI workflows (needs a careful review)

<!-- Process: PRs go into `development` (you can merge your own once checks pass).
Test on dev, including the Impact items above, then mark it "Verified on dev" in Release Desk.
Release PRs into main/master need approval from someone other than the author. -->
