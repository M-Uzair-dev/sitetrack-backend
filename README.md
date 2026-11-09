# SiteTrack API

Backend for **SiteTrack**, a tracker for construction projects and materials. It covers projects, tasks with dependency chains, team membership and invitations, a shared materials catalogue, and deliveries between the company store and project stores.

**Stack:** TypeScript · NestJS 11 · PostgreSQL 16 · Prisma 6 · Docker Compose

---

## Quick start (for the evaluator)

The only requirement is Docker with Compose v2.

```bash
# 1. Start the API and the database (migrations run automatically)
docker compose up --build
#    API:     http://localhost:3000/api/v1
#    Swagger: http://localhost:3000/docs
#    Health:  http://localhost:3000/api/v1/health

# 2. (in a second terminal) Load data at the brief's scale. Takes a few minutes.
docker compose --profile seed run --rm seed

# 3. Log in with a seeded account (every seeded password is Password123!)
curl -s -X POST localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@sitetrack.test","password":"Password123!"}'
```

| Seeded account | Role | Good for |
|---|---|---|
| `admin@sitetrack.test` | SuperAdmin | everything; PRJ-0001 has 3,000 tasks |
| `store@sitetrack.test` | Company store manager | company stock and deliveries screens |
| `user@sitetrack.test` | User | member of 20 projects (admin of a few), has pending invitations |
| `user1@sitetrack.test` … `user4997@sitetrack.test` | mixed | #1–50 SuperAdmin, #51–150 store managers, the rest users |

Other useful commands:

```bash
docker compose down            # stop (data is kept in the pgdata volume)
docker compose down -v         # stop and wipe the database
docker compose --profile seed run --rm -e SEED_FORCE=1 seed   # wipe and re-seed a non-empty DB
```

The seed refuses to run on a database that already has users unless you pass `SEED_FORCE=1`.

## Running the tests

```bash
npm ci
npm test                 # unit tests (dependency graph, Late/Blocked rules, status machine)

docker compose up -d     # e2e tests run against the running API
npm run test:e2e         # access control, IDs under concurrency, cycles, stock under concurrency...
```

To run the API outside Docker: `cp .env.example .env`, point `DATABASE_URL` at a Postgres 16, then run `npx prisma migrate deploy && npm run start:dev`.

## API documentation

- **[docs/API.md](docs/API.md)**: endpoints grouped by screen, response shapes, error format, and the auth flow for the frontend team.
- **Swagger UI** at `/docs` while the API runs. The static spec is [docs/openapi.json](docs/openapi.json), regenerated with `npm run build && npm run openapi`.

## Project layout

```
prisma/schema.prisma            data model
prisma/migrations/0001_init     generated SQL + hand-written constraints, partial indexes, sequence
src/auth                        register/login/refresh/logout, global auth guard
src/projects                    projects + ProjectAccessService (the single membership gate)
src/members                     members, invitations, notifications
src/tasks                       tasks, dependencies, status actions; project-graph.ts holds the graph rules
src/materials                   shared catalogue
src/stores                      company/project stock and deliveries
src/seed/seed.ts                bulk loader at brief scale
test/app.e2e-spec.ts            end-to-end business-rule tests
```

---

## Decisions and why

### Security and access
- **Membership and role are checked on every request, from the database.** The JWT only identifies the *session*. The guard loads the session and the user's current role on each call, and every project route goes through `ProjectAccessService`, which reads membership fresh. That is why removing a member or changing admin status takes effect on the very next request, and why logout works instantly.
- **Hidden projects return 404.** A non-member gets `404 Project not found` for a real project ID, exactly as for an ID that doesn't exist. Nested lookups (task by code, delivery by id, invitation by id) are always also filtered by the project, so a valid ID from another project still gives 404. Lists, counts and search only ever query the caller's visible projects.
- **Sessions.** Access JWTs live 15 minutes. Refresh tokens are random 256-bit values, stored only as SHA-256 hashes, rotated on every use, and slide to 30 days from last use. Active users therefore never get logged out, but a logged-out or stolen session dies. Re-using an already-rotated refresh token revokes the whole session (theft detection).
- **Passwords** are hashed with argon2. A failed login gives the same message and takes the same time (a dummy hash is checked) whether or not the email exists. The registration endpoint does have to say "email already exists". This is an accepted trade-off, since every registration form leaks this.
- **SuperAdmin** can read and work in every project, but member and invitation changes stay with **project admins**, as the brief says ("Only project admins change members…"). A SuperAdmin who isn't a project admin there gets 403 on those actions.
- **App role is chosen at registration**, as the brief states, including privileged roles. In production I'd gate `SUPER_ADMIN`/`COMPANY_STORE_MANAGER` behind an invite or an existing admin.
- **The materials catalogue** is readable by everyone logged in. Creating, editing and deleting materials is limited to store managers and SuperAdmins, since they own the warehouse.

### IDs
- **Project IDs** come from a Postgres sequence (`project_number_seq`). Sequences never hand out the same value twice and never roll back, so IDs are unique under concurrency and never reused. Past PRJ-9999 the number just grows wider.
- **Task IDs** come from a per-project counter (`projects.next_task_number`), incremented with `UPDATE … RETURNING` inside the create transaction. The row lock serialises concurrent creates in the same project, and the counter never goes down, so deleted task numbers are never reused. The e2e suite fires 20 parallel creates and checks for exactly T-0001…T-0020.
- **Projects and materials are soft-deleted**, because delivery and stock history refer to them. Tasks are hard-deleted along with their dependency links, and the counter still guarantees their IDs are never reused.

### Tasks and dependencies
- **Late and Blocked are never stored.** They are computed on read from today's date (UTC) and the current graph, so they can never go stale.
- A project has at most a few thousand tasks, so the **task screens load the project's whole graph** (tasks + edges, two indexed queries) and evaluate everything in memory: Blocked (memoised DFS), transitive "waits on / waited on by" with shortest distance (BFS), cycle checks and allowed actions. This keeps all the graph rules in one small, unit-tested class (`src/tasks/project-graph.ts`). Filtering and sorting by the derived flags is then trivial and fast.
- **Every graph-changing write** (add dependency, start, complete, reopen, delete) takes a per-project advisory lock and re-reads the graph inside the transaction. Two concurrent requests therefore can't create a cycle together, or race a Start against a Reopen.
- **Status rules**, exactly as in the brief:
  - Start: Not started → In progress, only when everything it waits on (transitively) is Done.
  - Mark as done: In progress → Done.
  - Reopen: Done → In progress, only while no task that waits on it (transitively) has started.
  - Anything else → 409 with a reason.
- Adding a dependency to a task that has already started is allowed. Its Blocked flag simply reflects it, since the brief defines Blocked as derived state.

### Materials and deliveries
- **Stock can't go negative.** Each line is a single guarded `UPDATE … SET quantity = quantity - q WHERE quantity >= q`. If no row is updated, the whole delivery rolls back with 409. A `CHECK (quantity >= 0)` constraint backs this up. Lines are processed in material-id order so concurrent multi-line deliveries can't deadlock. The e2e suite sends 10 parallel deliveries against stock for 7 and checks that exactly 7 succeed.
- **Every movement is one transaction**: add stock, send, record, reject, cancel. A delivery leaves In transit through a conditional `UPDATE … WHERE status = 'IN_TRANSIT'`, so two people acting at once can't both succeed.
- **Who does what:**
  - Company → project deliveries: store managers send and cancel, project members record and reject.
  - Project → company returns: project members send and cancel, store managers record and reject.
  - "Sender" means the sending side, not only the individual who pressed the button.
- **"Quantity in transit to projects"** is a running total (`stock.in_transit_out`) on the company stock row, updated in the same transaction as each send or settle. The stock screen never has to aggregate 3M delivery lines.
- **Project store "last delivery"** is the last time stock moved in or out of that store for that material.
- A project can't be deleted while it has deliveries in transit.

### Performance at the brief's scale

The seed loads 5,000 users, 2,000 projects, 50k invitations, 500,866 tasks, 1,000,980 dependencies, 20k materials, 400k deliveries and 3M lines in about 10 minutes on a 4-CPU laptop. Response times measured against that data, warm:

| Screen | Request | Time |
|---|---|---|
| Projects (SuperAdmin, all 2,000) | `/projects?sort=lateTasks&order=desc` | ~0.3 s |
| Projects (regular user) | `/projects` | ~0.1 s |
| Tasks, PRJ-0001 (3,000 tasks) | `/projects/PRJ-0001/tasks?blocked=true&sort=dependentsCount` | ~70 ms |
| Task details | `/projects/PRJ-0001/tasks/PRJ-0001-T-2500` | ~70 ms |
| Project store / deliveries | `/projects/PRJ-0001/store`, `/deliveries` | ~30 ms |
| Company stock / deliveries | `/company-store/stock?status=LOW_STOCK`, `/company-store/deliveries` | ~30 ms |
| Notifications | `/me/notifications` | ~35 ms |

How each screen gets there:
- **Projects list:** one SQL statement applies visibility, search, the late filter, the sort and paging, with task counts and late counts aggregated by an index on `(project_id, status, planned_start, planned_end)`. The Blocked count isn't sortable or filterable, so it is computed only for the projects on the current page, using the same in-memory graph code as the task screens. That was about 10× faster than a recursive CTE.
- **Task screens:** bounded by one project's size (≤ 3k tasks), handled in memory as described above.
- **Deliveries:** indexes on `(project_id, sent_at desc)`, `(status, sent_at desc)`, `(direction, sent_at desc)` and `sent_at desc`.
- **Search:** trigram GIN indexes make case-insensitive "contains" search on project and material names fast.
- **Database tuning:** Postgres in compose is tuned modestly for a small box.

## Trade-offs I accepted
- **Offset pagination**, which is simple for screens with page numbers. Deep pages on the 400k-row deliveries table get slower. Keyset pagination would fix that.
- **Derived flags on read**, which costs a graph load per task-screen request (a few ms for 3k tasks) in exchange for always-correct flags and no stale-state bugs.
- **One database round trip per request for the session check.** This is the price of instant logout and instant revocation. A short-TTL cache could cut it, at the cost of a few seconds of staleness.
- **Seeded project stock** is derived from the generated delivery history and clamped at zero. Generated returns are kept small, so this rarely matters, but the synthetic history isn't a perfect ledger.
- **No notification types besides invitations**, because the brief only describes invitations.

## What I'd add with more time
- Rate limiting and lockout on login, and a password reset flow.
- Keyset pagination for deliveries and notifications, and ETags / caching on the projects list.
- An audit log of stock movements, including supplier receipts with reference numbers.
- Materialised per-project task stats kept up to date by triggers, if the projects list ever needs to scale well beyond the brief.
- A CI pipeline (build, unit, e2e against compose) and k6 load tests against the seeded data.
- Stock consumption on site (material used by tasks), which the brief doesn't cover yet.
