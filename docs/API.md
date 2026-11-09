# SiteTrack API reference

Base URL: `http://localhost:3000/api/v1`. Interactive Swagger UI is at `http://localhost:3000/docs`, and the machine-readable spec is in [`openapi.json`](openapi.json).

## Conventions

| Topic | Rule |
|---|---|
| Auth | `Authorization: Bearer <accessToken>` on every route except register/login/refresh/health. |
| IDs | Projects are addressed by code (`PRJ-0042`), tasks by code (`PRJ-0042-T-0137`). Users, materials, invitations and deliveries use numeric ids. |
| Dates | Planned dates are `YYYY-MM-DD`. Timestamps are ISO-8601 UTC. |
| Quantities | Decimal strings with up to 3 decimals (`"12.500"`). They are accepted as a number or a string. |
| Lists | `?page=1&pageSize=25` (max 100) → `{ data: [...], page, pageSize, total }`. Sorting uses `?sort=<field>&order=asc\|desc`. Multi-value filters are comma-separated (`?status=IN_PROGRESS,DONE`). |
| Errors | `{ statusCode, error, message, details? }`. `400` validation (with `details`), `401` not logged in or session ended, `403` role/admin rule, `404` not found **or not visible to you**, `409` a business rule or state conflict (message explains why). |

A project you are not a member of always answers `404 Project not found`, exactly like a project that does not exist (SuperAdmins see every project).

## Auth (screens 1–2)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/auth/register` | `{ name, email, password (≥8), role: USER\|COMPANY_STORE_MANAGER\|SUPER_ADMIN }` | `201 { user, accessToken, accessTokenExpiresIn, refreshToken, refreshTokenExpiresAt }` |
| POST | `/auth/login` | `{ email, password }` | `200` same shape. Any failure → `401 Invalid email or password` |
| POST | `/auth/refresh` | `{ refreshToken }` | `200` new access + **new** refresh token (the old one stops working) |
| POST | `/auth/logout` | — | `204`. This session's tokens stop working immediately |
| GET | `/me` | — | `{ id, name, email, role, createdAt }` |

**Client flow:** access tokens live 15 minutes. When a call returns 401, call `/auth/refresh` once and retry. Refresh tokens slide (30 days from last use), so active users are never asked to log in again. If an already-used refresh token is presented again, the whole session is revoked.

## Notifications (screen 3)

| Method | Path | Notes |
|---|---|---|
| GET | `/me/notifications?page` | Newest first. Item: `{ id, type: "PROJECT_INVITATION", project: {code,name}, invitedBy: {id,name}, status, createdAt, respondedAt, read, canRespond }`. The response also includes `unread`. |
| GET | `/me/notifications/unread-count` | `{ unread }`: a cheap call for the badge shown on every page |
| POST | `/me/notifications/read` | `{ ids?: number[] }` (omit to mark all) → `{ unread }` |
| POST | `/me/invitations/:id/accept` | Only the invitee. Joins the project. `409` if already answered or withdrawn |
| POST | `/me/invitations/:id/reject` | Only the invitee |

## Projects (screen 4)

| Method | Path | Notes |
|---|---|---|
| GET | `/projects` | `search` (name or ID), `hasLateTasks=true`, `sort=name\|startDate\|percentDone\|lateTasks`, `order`, paging |
| POST | `/projects` | `{ name, plannedStart, plannedEnd }`. The caller becomes project admin. ID is `PRJ-nnnn` |
| GET | `/projects/:code` | One project, same shape |
| PATCH | `/projects/:code` | Project admin. `{ name?, plannedStart?, plannedEnd? }` |
| DELETE | `/projects/:code` | Project admin. Soft delete. `409` while deliveries are in transit |

Project item:
```json
{ "code": "PRJ-0042", "name": "Harbour Office Block", "plannedStart": "2026-01-10", "plannedEnd": "2027-03-01",
  "isAdmin": true, "memberCount": 12,
  "taskCounts": { "notStarted": 40, "inProgress": 12, "done": 81, "total": 133 },
  "percentDone": 60.9, "lateTasks": 7, "blockedTasks": 31 }
```

## Tasks (screens 5–6)

| Method | Path | Notes |
|---|---|---|
| GET | `/projects/:code/tasks` | Filters: `status`, `late=true\|false`, `blocked=true\|false`, `from`/`to` (planned period overlaps), `search` (name or ID). `sort=code\|name\|startDate\|endDate\|dependentsCount` |
| POST | `/projects/:code/tasks` | `{ name, plannedStart, plannedEnd, dependsOn?: ["PRJ-0042-T-0001"] }` |
| GET | `/projects/:code/tasks/:taskCode` | Details (below) |
| PATCH | `/projects/:code/tasks/:taskCode` | `{ name?, plannedStart?, plannedEnd? }`. Status changes only through the actions |
| DELETE | `/projects/:code/tasks/:taskCode` | Also removes its dependency links. The ID is never reused |
| POST | `/projects/:code/tasks/:taskCode/start` | Not started → In progress. Only when everything it waits on is done |
| POST | `/projects/:code/tasks/:taskCode/complete` | In progress → Done |
| POST | `/projects/:code/tasks/:taskCode/reopen` | Done → In progress. Only while no task waiting on it has started |
| POST | `/projects/:code/tasks/:taskCode/dependencies` | `{ dependsOn: "<task code>" }`. Same project only. A cycle → `409` |
| DELETE | `/projects/:code/tasks/:taskCode/dependencies/:dependsOnCode` | Remove a link |

List item:
```json
{ "code": "PRJ-0042-T-0003", "name": "Pour slab - level 2", "plannedStart": "2026-02-01", "plannedEnd": "2026-02-10",
  "status": "NOT_STARTED", "late": true, "blocked": true,
  "dependsOn": [{ "code": "PRJ-0042-T-0002", "name": "...", "status": "IN_PROGRESS" }], "dependentsCount": 2 }
```
Details add `startedAt`, `doneAt`, `createdAt`, `allowedActions: ["start"|"complete"|"reopen"]`, and `waitsOn` / `waitedOnBy`: every task reachable in that direction, as `{ code, name, status, late, blocked, distance }` (distance 1 = direct), sorted by distance.

`late` and `blocked` are never stored. They are computed on every read from today's date (UTC) and the current state of the dependency graph.

## Members (screen 9)

| Method | Path | Notes |
|---|---|---|
| GET | `/projects/:code/members` | `{ project, callerIsAdmin, members: [{userId,name,email,isAdmin,joinedAt}], pendingInvitations: [{id, invitee, invitedBy, createdAt}] }` |
| POST | `/projects/:code/invitations` | Admin. `{ userId }` or `{ email }`. `409` if already a member or already invited |
| DELETE | `/projects/:code/invitations/:id` | Admin. Withdraw an unanswered invitation |
| PATCH | `/projects/:code/members/:userId` | Admin. `{ isAdmin: true\|false }`. Can never leave the project with zero admins (`409`) |
| DELETE | `/projects/:code/members/:userId` | Admin. Removes a member. Last admin → `409` |

## Materials (shared catalogue)

| Method | Path | Notes |
|---|---|---|
| GET | `/materials` | Any logged-in user. `search`, `category`, `sort=name\|category` |
| GET | `/materials/categories` | Distinct categories |
| GET | `/materials/:id` | |
| POST/PATCH/DELETE | `/materials[/:id]` | Store managers and SuperAdmins. `{ name, category, unit }`. Delete is soft |

## Project store & deliveries (screens 7–8): project members

| Method | Path | Notes |
|---|---|---|
| GET | `/projects/:code/store` | `search`, `category`, `sort=name\|quantity\|lastDelivery`. Item: `{ material:{id,name,category,unit}, quantity, unit, lastDeliveryAt }` |
| GET | `/projects/:code/deliveries` | Newest first. `direction=TO_PROJECT\|TO_COMPANY`, `status`, `from`/`to` (sent date) |
| GET | `/projects/:code/deliveries/:id` | |
| POST | `/projects/:code/deliveries` | Send material back to the company store: `{ lines: [{ materialId, quantity }] }` |
| POST | `/projects/:code/deliveries/:id/record` | Incoming (`TO_PROJECT`) only: stock joins the project store |
| POST | `/projects/:code/deliveries/:id/reject` | Incoming only: stock returns to the company store |
| POST | `/projects/:code/deliveries/:id/cancel` | Outgoing (`TO_COMPANY`) only, while in transit |

## Company store (screens 10–11): store managers and SuperAdmins

| Method | Path | Notes |
|---|---|---|
| GET | `/company-store/stock` | `status=OUT_OF_STOCK,LOW_STOCK,AVAILABLE`, `category`, `search`, `sort=name\|quantity\|status`. Item: `{ material, quantity, unit, inTransitToProjects, reorderPoint, status }` |
| POST | `/company-store/stock` | Add stock from a supplier: `{ lines: [{ materialId, quantity }] }` |
| PUT | `/company-store/stock/:materialId/reorder-point` | `{ reorderPoint }` |
| GET | `/company-store/deliveries` | All projects, newest first. `projectCode`, `direction`, `status`, `from`/`to` |
| POST | `/company-store/deliveries` | `{ projectCode, lines: [{ materialId, quantity }] }` → In transit |
| POST | `/company-store/deliveries/:id/record` | Returns from projects (`TO_COMPANY`) only |
| POST | `/company-store/deliveries/:id/reject` | Returns only: stock goes back to the project |
| POST | `/company-store/deliveries/:id/cancel` | Outgoing (`TO_PROJECT`) only, while in transit |

Delivery item:
```json
{ "id": 812, "project": { "code": "PRJ-0042", "name": "..." }, "direction": "TO_PROJECT",
  "from": "COMPANY_STORE", "to": "PROJECT_STORE", "status": "IN_TRANSIT",
  "lines": [{ "materialId": 7, "name": "Cement, OPC 50 kg bag - Premium #00007", "category": "Cement", "unit": "bag", "quantity": "30" }],
  "sentAt": "...", "sentBy": { "id": 2, "name": "Sam Storekeeper" },
  "receivedAt": null, "receivedBy": null, "cancelledAt": null, "cancelledBy": null }
```
Delivery statuses: `IN_TRANSIT → DELIVERED | REJECTED | CANCELLED`. Each transition is atomic and happens at most once, and a delivery is never edited after it is sent. Stock can never go negative: a send that exceeds available stock returns `409`.
