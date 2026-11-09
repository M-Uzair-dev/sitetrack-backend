/**
 * Bulk loader that fills a fresh database at (at least) the scale in the brief:
 *   5,000 users · 2,000 projects (5-50 members) · 50,000 invitations · ~500,000 tasks (3,000 in PRJ-0001)
 *   1,000,000 task dependencies · 20,000 materials · 400,000 deliveries with 3,000,000 lines.
 *
 * Everything is generated inside Postgres with generate_series, so it runs in minutes.
 * Usage (inside docker):  docker compose --profile seed run --rm seed
 * Re-seed a non-empty DB:  SEED_FORCE=1  (wipes all data first)
 *
 * Every seeded account uses the password  Password123!
 * Demo logins: admin@sitetrack.test (SuperAdmin), store@sitetrack.test (store manager), user@sitetrack.test (user).
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

const PASSWORD = 'Password123!';
const TARGET_DEPS = 1_000_000;

const arr = (xs: string[]) => `(ARRAY[${xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(",")}])`;

const FIRST = ['Aisha', 'Ben', 'Carlos', 'Divya', 'Ethan', 'Fatima', 'George', 'Hana', 'Ivan', 'Jade', 'Kofi', 'Lena', 'Mateo', 'Nadia', 'Omar', 'Priya', 'Quinn', 'Rosa', 'Sami', 'Tara', 'Usman', 'Vera', 'Wei', 'Ximena', 'Yusuf', 'Zara', 'Ali', 'Bilal', 'Chloe', 'Daniel', 'Elif', 'Farhan', 'Grace', 'Hamza', 'Isla', 'Jonas', 'Kiran', 'Leo', 'Maya', 'Noah'];
const LAST = ['Khan', 'Smith', 'Garcia', 'Patel', 'Nguyen', 'Müller', 'Rossi', 'Kowalski', 'Haddad', 'Okafor', 'Silva', 'Tanaka', 'Ahmed', 'Brown', 'Ivanova', 'Jensen', 'Lopez', 'Malik', 'Novak', "O'Brien", 'Park', 'Qureshi', 'Reyes', 'Schmidt', 'Turner', 'Usman', 'Varga', 'Wilson', 'Yilmaz', 'Zhang', 'Iqbal', 'Chen', 'Das', 'Evans', 'Fischer', 'Gomez', 'Hughes'];
const SITES = ['Riverside', 'Harbour', 'Northgate', 'Cedar Park', 'Eastfield', 'Hilltop', 'Westbrook', 'Lakeside', 'Old Town', 'Meadow', 'Station Road', 'Kingsway', 'Bayview', 'Greenway', 'Summit', 'Millbank', 'Canal Street', 'Oakridge', 'Southpoint', 'Elm Grove', 'Marina', 'Crescent', 'Parkside', 'Highfield', 'Foxhall', 'Ironworks', 'Quayside', 'Bridgewater', 'Stonecross', 'Airport Link'];
const KINDS = ['Residential Tower', 'Office Block', 'Shopping Centre', 'Hospital Wing', 'School', 'Warehouse', 'Bridge', 'Car Park', 'Hotel', 'Apartments', 'Data Centre', 'Metro Station', 'Sports Hall', 'Library', 'Factory', 'Townhouses', 'Clinic', 'Depot', 'Campus Building', 'Mixed-use Block'];
const VERBS = ['Pour', 'Install', 'Excavate', 'Erect', 'Inspect', 'Survey', 'Waterproof', 'Plaster', 'Paint', 'Tile', 'Wire', 'Plumb', 'Insulate', 'Frame', 'Clad', 'Level', 'Backfill', 'Commission', 'Glaze', 'Screed'];
const OBJECTS = ['slab', 'columns', 'foundations', 'retaining wall', 'roof deck', 'staircase', 'lift shaft', 'facade panels', 'HVAC ducts', 'fire sprinklers', 'drainage', 'partition walls', 'windows', 'electrical risers', 'basement', 'parking ramp', 'balconies', 'ceiling grid', 'flooring', 'scaffolding'];
const ZONES = ['level 1', 'level 2', 'level 3', 'level 4', 'level 5', 'basement', 'roof', 'east wing', 'west wing', 'core', 'north side', 'south side', 'podium', 'block A', 'block B'];
const ITEMS: Array<[string, string, string]> = [
  ['Cement, OPC 50 kg bag', 'Cement', 'bag'], ['Cement, PPC 50 kg bag', 'Cement', 'bag'], ['White cement 25 kg bag', 'Cement', 'bag'],
  ['Rebar 12 mm', 'Steel', 'ton'], ['Rebar 16 mm', 'Steel', 'ton'], ['Steel I-beam 200', 'Steel', 'piece'], ['Binding wire', 'Steel', 'kg'],
  ['Sand, fine', 'Aggregates', 'm³'], ['Crushed stone 20 mm', 'Aggregates', 'm³'], ['Gravel', 'Aggregates', 'm³'],
  ['Plywood 18 mm sheet', 'Timber', 'piece'], ['Timber 2x4', 'Timber', 'm'], ['Shuttering board', 'Timber', 'm²'],
  ['Red brick', 'Bricks & Blocks', 'piece'], ['Concrete block 200 mm', 'Bricks & Blocks', 'piece'], ['AAC block', 'Bricks & Blocks', 'piece'],
  ['Copper cable 2.5 mm²', 'Electrical', 'm'], ['PVC conduit 20 mm', 'Electrical', 'm'], ['Distribution board', 'Electrical', 'piece'], ['LED panel light', 'Electrical', 'piece'],
  ['PVC pipe 110 mm', 'Plumbing', 'm'], ['PPR pipe 25 mm', 'Plumbing', 'm'], ['Gate valve 50 mm', 'Plumbing', 'piece'],
  ['Ceramic floor tile 600x600', 'Finishes', 'm²'], ['Gypsum board 12.5 mm', 'Finishes', 'piece'], ['Tile adhesive 20 kg', 'Finishes', 'bag'],
  ['Emulsion paint 20 L', 'Paint', 'litre'], ['Primer 20 L', 'Paint', 'litre'], ['Anchor bolt M12', 'Hardware', 'piece'], ['Wood screws box', 'Hardware', 'box'],
  ['Safety helmet', 'Safety', 'piece'], ['High-vis vest', 'Safety', 'piece'], ['Safety harness', 'Safety', 'piece'],
  ['Float glass 6 mm', 'Glass', 'm²'], ['Roof sheet 0.5 mm', 'Roofing', 'm²'], ['Bitumen membrane', 'Roofing', 'roll'],
  ['Rock wool 50 mm', 'Insulation', 'm²'], ['XPS board 30 mm', 'Insulation', 'm²'], ['Angle grinder disc', 'Tools', 'piece'], ['Ready-mix concrete C30', 'Concrete', 'm³'],
];
const SPECS = ['Standard', 'Premium', 'Economy', 'Grade A', 'Grade B', 'Heavy duty', 'Imported', 'Local', 'Type I', 'Type II'];

async function main() {
  const url = process.env.DATABASE_URL ?? '';
  const prisma = new PrismaClient({ datasourceUrl: url.includes('connection_limit') ? url : `${url}${url.includes('?') ? '&' : '?'}connection_limit=1` });
  const t0 = Date.now();
  const step = async (label: string, sql: string, ...params: unknown[]) => {
    const t = Date.now();
    const n = await prisma.$executeRawUnsafe(sql, ...params);
    console.log(`  ${label.padEnd(44)} ${String(n).padStart(9)} rows  ${((Date.now() - t) / 1000).toFixed(1)}s`);
    return n;
  };
  const count = async (table: string) => (await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`))[0].n;

  const existing = await count('users');
  if (existing > 0 && process.env.SEED_FORCE !== '1') {
    console.log(`Database already has ${existing} users; skipping seed. Set SEED_FORCE=1 to wipe and re-seed.`);
    await prisma.$disconnect();
    return;
  }

  console.log('Seeding SiteTrack at brief scale...');
  await prisma.$executeRawUnsafe(`SET synchronous_commit = off`);
  await prisma.$executeRawUnsafe(`SET work_mem = '128MB'`);
  await prisma.$executeRawUnsafe(
    `TRUNCATE users, sessions, projects, project_members, invitations, tasks, task_dependencies, materials, stores, stock, deliveries, delivery_lines RESTART IDENTITY CASCADE`,
  );
  await prisma.$executeRawUnsafe(`INSERT INTO stores (kind) VALUES ('COMPANY')`);
  const hash = await argon2.hash(PASSWORD);

  // ---- users (ids 1-3 demo accounts, 4.. generated; generated #1-50 SuperAdmin, #51-150 store managers)
  await step('users (demo)', `
    INSERT INTO users (name, email, password_hash, role) VALUES
      ('Ada Admin', 'admin@sitetrack.test', $1, 'SUPER_ADMIN'),
      ('Sam Storekeeper', 'store@sitetrack.test', $1, 'COMPANY_STORE_MANAGER'),
      ('Uma User', 'user@sitetrack.test', $1, 'USER')`, hash);
  await step('users', `
    INSERT INTO users (name, email, password_hash, role, created_at)
    SELECT ${arr(FIRST)}[1 + g % ${FIRST.length}] || ' ' || ${arr(LAST)}[1 + (g * 7) % ${LAST.length}],
           'user' || g || '@sitetrack.test', $1,
           (CASE WHEN g <= 50 THEN 'SUPER_ADMIN' WHEN g <= 150 THEN 'COMPANY_STORE_MANAGER' ELSE 'USER' END)::"AppRole",
           now() - ((g % 1400) || ' days')::interval
    FROM generate_series(1, 4997) g`, hash);

  // ---- projects + stores
  await step('projects', `
    INSERT INTO projects (number, code, name, planned_start, planned_end, next_task_number, created_by_id, created_at, updated_at)
    SELECT g, 'PRJ-' || lpad(g::text, 4, '0'),
           ${arr(SITES)}[1 + g % ${SITES.length}] || ' ' || ${arr(KINDS)}[1 + (g / ${SITES.length}) % ${KINDS.length}]
             || CASE WHEN g % 3 = 0 THEN ' Phase ' || (1 + g % 4) ELSE '' END,
           s, s + (120 + (g * 37) % 600), 1,
           4 + ((g::bigint * 7919) % 4997)::int, s::timestamp - interval '30 days', now()
    FROM (SELECT g, current_date - 1460 + ((g * 797) % 1825) AS s FROM generate_series(1, 2000) g) x`);
  await prisma.$executeRawUnsafe(`SELECT setval('project_number_seq', 2000)`);
  await step('project stores', `INSERT INTO stores (kind, project_id) SELECT 'PROJECT', id FROM projects ORDER BY id`);

  // ---- members: 5..50 per project; member #0 is the creator/admin, plus ~10% extra admins
  await step('project members', `
    INSERT INTO project_members (project_id, user_id, is_admin, joined_at)
    SELECT p.id, 4 + ((p.id::bigint * 7919 + i * 97) % 4997)::int, (i = 0 OR i % 10 = 5), p.created_at + (i || ' days')::interval
    FROM projects p CROSS JOIN generate_series(0, 49) i
    WHERE i < 5 + (p.id * 7) % 46`);
  await step('demo user memberships', `
    INSERT INTO project_members (project_id, user_id, is_admin, joined_at)
    SELECT id, 3, id % 200 = 1, created_at FROM projects WHERE id % 100 = 1
    UNION ALL SELECT id, 2, false, created_at FROM projects WHERE id % 200 = 2
    ON CONFLICT DO NOTHING`);

  // ---- invitations: 25 per project to non-members (40% pending, 40% rejected, 20% withdrawn)
  await step('invitations', `
    INSERT INTO invitations (project_id, invitee_id, invited_by_id, status, created_at, responded_at, read_at)
    SELECT p.id, 4 + ((p.id::bigint * 7919 + i * 97) % 4997)::int, p.created_by_id, x.st, x.ts,
           CASE WHEN x.st <> 'PENDING' THEN x.ts + interval '2 days' END,
           CASE WHEN x.st <> 'PENDING' OR (p.id + i) % 3 = 0 THEN x.ts + interval '1 day' END
    FROM projects p CROSS JOIN generate_series(50, 74) i
    CROSS JOIN LATERAL (
      SELECT (CASE WHEN (p.id + i) % 10 < 4 THEN 'PENDING' WHEN (p.id + i) % 10 < 8 THEN 'REJECTED' ELSE 'WITHDRAWN' END)::"InvitationStatus" AS st,
             now() - (((p.id * 13 + i * 31) % 900) || ' days')::interval AS ts
    ) x`);
  await step('demo user invitations', `
    INSERT INTO invitations (project_id, invitee_id, invited_by_id, status, created_at)
    SELECT id, 3, created_by_id, 'PENDING', now() - ((id % 30) || ' days')::interval FROM projects WHERE id % 250 = 7`);

  // ---- tasks: PRJ-0001 has 3,000; others 149..349 (~249 avg). Done up to a date-driven frontier.
  await step('tasks', `
    INSERT INTO tasks (project_id, number, code, name, planned_start, planned_end, status, started_at, done_at, created_at, updated_at)
    SELECT p.id, n, p.code || '-T-' || lpad(n::text, 4, '0'),
           ${arr(VERBS)}[1 + (n * 7 + p.id) % ${VERBS.length}] || ' ' || ${arr(OBJECTS)}[1 + (n * 13 + p.id * 3) % ${OBJECTS.length}]
             || ' - ' || ${arr(ZONES)}[1 + (n + p.id) % ${ZONES.length}],
           a.ts, a.ts + 2 + (n * 11) % 20, c.st,
           CASE WHEN c.st = 'DONE' THEN a.ts::timestamp END,
           CASE WHEN c.st = 'DONE' THEN (a.ts + 2 + (n * 11) % 20)::timestamp END,
           p.created_at, now()
    FROM (
      SELECT p.*, CASE WHEN p.id = 1 THEN 3000 ELSE 149 + ((p.id * 37) % 201) END AS cnt,
             GREATEST(p.planned_end - p.planned_start, 1) AS span,
             LEAST(GREATEST((current_date - p.planned_start)::float / GREATEST(p.planned_end - p.planned_start, 1), 0), 1) AS elapsed
      FROM projects p
    ) p
    CROSS JOIN LATERAL generate_series(1, p.cnt) n
    CROSS JOIN LATERAL (SELECT p.planned_start + ((p.span * (n - 1)) / p.cnt) AS ts) a
    CROSS JOIN LATERAL (
      SELECT (CASE WHEN n <= floor(p.cnt * p.elapsed * CASE WHEN p.elapsed >= 1 THEN 0.98 ELSE 0.85 END)
                   THEN 'DONE' ELSE 'NOT_STARTED' END)::"TaskStatus" AS st
    ) c`);
  await step('task counters', `
    UPDATE projects p SET next_task_number = c.m + 1
    FROM (SELECT project_id, max(number) AS m FROM tasks GROUP BY project_id) c WHERE c.project_id = p.id`);

  // ---- dependencies: always to a lower-numbered task in the same project => acyclic by construction
  for (let j = 1; ; j++) {
    const have = await count('task_dependencies');
    if (have >= TARGET_DEPS) break;
    const limit = j <= 2 ? '' : `LIMIT ${TARGET_DEPS - have + 1000}`;
    await step(`task dependencies (pass ${j})`, `
      INSERT INTO task_dependencies (task_id, depends_on_id, project_id)
      SELECT t.id, d.id, t.project_id
      FROM tasks t
      JOIN tasks d ON d.project_id = t.project_id
                  AND d.number = t.number - 1 - ((t.number * 31 + ${j} * 17 + t.project_id) % LEAST(t.number - 1, 15))
      WHERE t.number > 1 ${limit}
      ON CONFLICT DO NOTHING`);
    if (j > 10) break;
  }
  // Start some tasks whose prerequisites are all done (keeps the status rules consistent).
  await step('tasks in progress', `
    UPDATE tasks t SET status = 'IN_PROGRESS', started_at = t.planned_start::timestamp
    WHERE t.status = 'NOT_STARTED' AND t.planned_start <= current_date + 7 AND t.id % 3 <> 0
      AND NOT EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks pre ON pre.id = d.depends_on_id
                      WHERE d.task_id = t.id AND pre.status <> 'DONE')`);

  // ---- materials
  const names = arr(ITEMS.map((i) => i[0]));
  const cats = arr(ITEMS.map((i) => i[1]));
  const units = arr(ITEMS.map((i) => i[2]));
  await step('materials', `
    INSERT INTO materials (name, category, unit, created_at)
    SELECT ${names}[k] || ' - ' || ${arr(SPECS)}[1 + (g / ${ITEMS.length}) % ${SPECS.length}] || ' #' || lpad(g::text, 5, '0'),
           ${cats}[k], ${units}[k], now() - ((g % 1400) || ' days')::interval
    FROM (SELECT g, 1 + g % ${ITEMS.length} AS k FROM generate_series(1, 20000) g) x`);

  // ---- deliveries: 80% company->project, 20% returns; the most recent ones are still in transit
  await step('deliveries', `
    INSERT INTO deliveries (direction, status, project_id, sent_by_id, sent_at, received_by_id, received_at, cancelled_by_id, cancelled_at)
    SELECT dir, st, pid,
           CASE WHEN dir = 'TO_PROJECT' THEN csm ELSE member END,
           sent,
           CASE WHEN st IN ('DELIVERED', 'REJECTED') THEN (CASE WHEN dir = 'TO_PROJECT' THEN member ELSE csm END) END,
           CASE WHEN st IN ('DELIVERED', 'REJECTED') THEN LEAST(sent + interval '1 day' * (1 + g % 3), now()) END,
           CASE WHEN st = 'CANCELLED' THEN (CASE WHEN dir = 'TO_PROJECT' THEN csm ELSE member END) END,
           CASE WHEN st = 'CANCELLED' THEN LEAST(sent + interval '6 hours', now()) END
    FROM (
      SELECT g, 1 + ((g::bigint * 7919) % 2000)::int AS pid,
             (CASE WHEN g % 5 = 0 THEN 'TO_COMPANY' ELSE 'TO_PROJECT' END)::"DeliveryDirection" AS dir,
             (CASE WHEN g > 394000 AND g % 3 <> 0 THEN 'IN_TRANSIT'
                   WHEN (g * 37) % 100 < 88 THEN 'DELIVERED'
                   WHEN (g * 37) % 100 < 94 THEN 'REJECTED' ELSE 'CANCELLED' END)::"DeliveryStatus" AS st,
             now() - (400000 - g) * interval '5 minutes' - interval '1 hour' AS sent,
             54 + (g % 100) AS csm,
             4 + (((1 + ((g::bigint * 7919) % 2000)) * 7919 + (g % 5) * 97) % 4997)::int AS member
      FROM generate_series(1, 400000) g
    ) x`);
  // 7 or 8 lines each => exactly 3,000,000; each project draws from its own pool of 60 materials
  await step('delivery lines', `
    INSERT INTO delivery_lines (delivery_id, material_id, quantity)
    SELECT d.id,
           1 + ((d.project_id::bigint * 997 + ((d.id::bigint * 7 + k * 13) % 60)) % 20000)::int,
           CASE WHEN d.direction = 'TO_PROJECT' THEN 5 + (d.id * 31 + k * 7) % 200 ELSE 1 + (d.id * 31 + k * 7) % 5 END
    FROM deliveries d CROSS JOIN LATERAL generate_series(0, 6 + d.id % 2) k`);

  // ---- stock derived from delivery history
  await step('project stock', `
    INSERT INTO stock (store_id, material_id, quantity, last_movement_at)
    SELECT s.id, x.material_id, GREATEST(x.qty, 0), x.last
    FROM (
      SELECT d.project_id, l.material_id,
             sum(CASE WHEN d.direction = 'TO_PROJECT' AND d.status = 'DELIVERED' THEN l.quantity
                      WHEN d.direction = 'TO_COMPANY' AND d.status IN ('DELIVERED', 'IN_TRANSIT') THEN -l.quantity
                      ELSE 0 END) AS qty,
             max(CASE WHEN d.direction = 'TO_PROJECT' AND d.status = 'DELIVERED' THEN d.received_at
                      WHEN d.direction = 'TO_COMPANY' AND d.status <> 'CANCELLED' THEN d.sent_at END) AS last
      FROM deliveries d JOIN delivery_lines l ON l.delivery_id = d.id
      GROUP BY d.project_id, l.material_id
    ) x JOIN stores s ON s.project_id = x.project_id`);
  await step('company stock', `
    INSERT INTO stock (store_id, material_id, quantity, reorder_point, in_transit_out, last_movement_at)
    SELECT (SELECT id FROM stores WHERE kind = 'COMPANY'), m.id,
           CASE WHEN m.id % 40 = 0 THEN 0
                WHEN m.id % 40 < 4 THEN (50 + (m.id * 13) % 150) / 2
                ELSE 500 + (m.id * 37) % 5000 END,
           50 + (m.id * 13) % 150,
           coalesce(it.q, 0),
           now() - ((m.id % 20) || ' days')::interval
    FROM materials m
    LEFT JOIN (
      SELECT l.material_id, sum(l.quantity) AS q
      FROM deliveries d JOIN delivery_lines l ON l.delivery_id = d.id
      WHERE d.status = 'IN_TRANSIT' AND d.direction = 'TO_PROJECT'
      GROUP BY l.material_id
    ) it ON it.material_id = m.id`);

  console.log('  VACUUM ANALYZE ...');
  await prisma.$executeRawUnsafe('VACUUM ANALYZE');

  console.log('\nRow counts:');
  for (const t of ['users', 'projects', 'project_members', 'invitations', 'tasks', 'task_dependencies', 'materials', 'deliveries', 'delivery_lines', 'stock']) {
    console.log(`  ${t.padEnd(20)} ${(await count(t)).toLocaleString('en-US')}`);
  }
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s. Log in as admin@sitetrack.test / store@sitetrack.test / user@sitetrack.test with password ${PASSWORD}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
