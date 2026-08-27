# next-api PostgreSQL connection budget

VAY-1308 measured the shared target RDS instance on 2026-08-19:

- PostgreSQL `max_connections`: 80
- reserved connections: 5 (3 superuser, 2 reserved-role)
- application-usable ceiling: 75
- observed steady state: 18 instance connections, 4 from the target database
- next-api ECS service: 1 desired task, rolling deployment maximum 2 tasks
- static next-api runtime constructors: 122 independent `pg.Pool` instances

The independent pools previously defaulted to as many as ten connections each.
Sequential staging requests therefore left enough route-specific idle clients to
exhaust the database despite low HTTP concurrency.

The next-api process now shares pools with identical database/client settings.
General pools, including query-timeout or application-name variants, allow eight
connections; pools with server/session tuning allow one. Acquisition is bounded at three seconds.
With the current two database URLs and three specialized target configurations,
the process budget is 19 connections, or 38 during a two-task rolling deploy.
Conservatively treating all 18 observed connections as external to those two
tasks leaves 19 usable connections of headroom.

The runtime logs its configured budget at startup and emits a warning containing
physical pool, connection, idle, and waiting counts while callers remain queued
for a connection. Acquisition exhaustion is returned as HTTP 503
`database_unavailable`, not an untyped HTTP 500.

Recheck this budget whenever the RDS class, ECS deployment maximum, database
URLs, or any key-distinguishing pool configuration changes.
