/**
 * End-to-end checks of the business rules against a running API (e.g. `docker compose up`).
 *   API_URL defaults to http://localhost:3000/api/v1
 *   npm run test:e2e
 */
import request from 'supertest';

const API = process.env.API_URL ?? 'http://localhost:3000/api/v1';
const run = Date.now().toString(36);
const api = () => request(API);

interface Session {
  id: number;
  token: string;
  refresh: string;
}

async function register(name: string, role = 'USER'): Promise<Session> {
  const res = await api()
    .post('/auth/register')
    .send({ name, email: `${name.toLowerCase()}-${run}@e2e.test`, password: 'Password123!', role })
    .expect(201);
  expect(res.body.user.passwordHash).toBeUndefined();
  return { id: res.body.user.id, token: res.body.accessToken, refresh: res.body.refreshToken };
}
const auth = (s: Session) => ({ Authorization: `Bearer ${s.token}` });

describe('SiteTrack API', () => {
  let admin: Session, member: Session, outsider: Session, store: Session;
  let project: string;

  beforeAll(async () => {
    [admin, member, outsider, store] = await Promise.all([
      register('Alice'),
      register('Bob'),
      register('Eve'),
      register('Stan', 'COMPANY_STORE_MANAGER'),
    ]);
    const res = await api().post('/projects').set(auth(admin)).send({ name: `E2E ${run}`, plannedStart: '2026-01-01', plannedEnd: '2027-01-01' }).expect(201);
    project = res.body.code;
    expect(project).toMatch(/^PRJ-\d{4,}$/);
    expect(res.body.isAdmin).toBe(true);
  });

  describe('auth', () => {
    it('login failure does not reveal whether the email exists', async () => {
      const a = await api().post('/auth/login').send({ email: `nobody-${run}@e2e.test`, password: 'whatever1' }).expect(401);
      const b = await api().post('/auth/login').send({ email: `alice-${run}@e2e.test`, password: 'wrong-password' }).expect(401);
      expect(a.body.message).toEqual(b.body.message);
    });

    it('refresh rotates tokens; logout kills the session immediately', async () => {
      const login = await api().post('/auth/login').send({ email: `alice-${run}@e2e.test`, password: 'Password123!' }).expect(200);
      const s = { id: 0, token: login.body.accessToken, refresh: login.body.refreshToken };
      const r = await api().post('/auth/refresh').send({ refreshToken: s.refresh }).expect(200);
      expect(r.body.refreshToken).not.toEqual(s.refresh);
      await api().get('/me').set(auth(s)).expect(200);
      await api().post('/auth/logout').set(auth(s)).expect(204);
      await api().get('/me').set(auth(s)).expect(401);
      await api().post('/auth/refresh').send({ refreshToken: r.body.refreshToken }).expect(401);
    });
  });

  describe('access control', () => {
    it('non-members get 404 for a real project and everything inside it', async () => {
      await api().get(`/projects/${project}`).set(auth(outsider)).expect(404);
      await api().get(`/projects/${project}/tasks`).set(auth(outsider)).expect(404);
      await api().get(`/projects/${project}/members`).set(auth(outsider)).expect(404);
      await api().get(`/projects/${project}/store`).set(auth(outsider)).expect(404);
      await api().get(`/projects/PRJ-9999999`).set(auth(outsider)).expect(404);
      const list = await api().get('/projects').query({ search: project }).set(auth(outsider)).expect(200);
      expect(list.body.total).toBe(0);
    });

    it('plain users cannot reach the company store', async () => {
      await api().get('/company-store/stock').set(auth(member)).expect(403);
      await api().get('/company-store/stock').set(auth(store)).expect(200);
    });
  });

  describe('members and invitations', () => {
    it('invite -> only the invitee can accept -> member; last admin cannot be removed', async () => {
      const inv = await api().post(`/projects/${project}/invitations`).set(auth(admin)).send({ userId: member.id }).expect(201);
      await api().post(`/projects/${project}/invitations`).set(auth(admin)).send({ userId: member.id }).expect(409);
      const unread = await api().get('/me/notifications/unread-count').set(auth(member)).expect(200);
      expect(unread.body.unread).toBeGreaterThanOrEqual(1);
      await api().post(`/me/invitations/${inv.body.id}/accept`).set(auth(outsider)).expect(404);
      await api().post(`/me/invitations/${inv.body.id}/accept`).set(auth(member)).expect(200);
      await api().post(`/me/invitations/${inv.body.id}/reject`).set(auth(member)).expect(409);
      await api().get(`/projects/${project}/tasks`).set(auth(member)).expect(200);
      // non-admin member cannot manage members
      await api().post(`/projects/${project}/invitations`).set(auth(member)).send({ userId: outsider.id }).expect(403);
      // last admin rule
      await api().delete(`/projects/${project}/members/${admin.id}`).set(auth(admin)).expect(409);
      await api().patch(`/projects/${project}/members/${admin.id}`).set(auth(admin)).send({ isAdmin: false }).expect(409);
    });

    it('removal takes effect on the very next request', async () => {
      const inv = await api().post(`/projects/${project}/invitations`).set(auth(admin)).send({ userId: outsider.id }).expect(201);
      await api().post(`/me/invitations/${inv.body.id}/accept`).set(auth(outsider)).expect(200);
      await api().get(`/projects/${project}`).set(auth(outsider)).expect(200);
      await api().delete(`/projects/${project}/members/${outsider.id}`).set(auth(admin)).expect(204);
      await api().get(`/projects/${project}`).set(auth(outsider)).expect(404);
    });
  });

  describe('tasks', () => {
    const t = (n: number) => `${project}-T-${String(n).padStart(4, '0')}`;

    it('assigns unique sequential IDs under concurrent creates', async () => {
      const res = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          api().post(`/projects/${project}/tasks`).set(auth(admin)).send({ name: `Task ${i}`, plannedStart: '2026-02-01', plannedEnd: '2026-03-01' }),
        ),
      );
      const codes = res.map((r) => r.body.code).sort();
      expect(new Set(codes).size).toBe(20);
      expect(codes[0]).toBe(t(1));
      expect(codes[19]).toBe(t(20));
    });

    it('dependencies: chain, cycle rejection, blocked flag, start/complete/reopen rules', async () => {
      // T2 waits on T1, T3 waits on T2
      await api().post(`/projects/${project}/tasks/${t(2)}/dependencies`).set(auth(admin)).send({ dependsOn: t(1) }).expect(201);
      await api().post(`/projects/${project}/tasks/${t(3)}/dependencies`).set(auth(admin)).send({ dependsOn: t(2) }).expect(201);
      await api().post(`/projects/${project}/tasks/${t(1)}/dependencies`).set(auth(admin)).send({ dependsOn: t(3) }).expect(409);
      await api().post(`/projects/${project}/tasks/${t(1)}/dependencies`).set(auth(admin)).send({ dependsOn: t(1) }).expect(409);

      const d3 = await api().get(`/projects/${project}/tasks/${t(3)}`).set(auth(member)).expect(200);
      expect(d3.body.blocked).toBe(true);
      expect(d3.body.allowedActions).toEqual([]);
      expect(d3.body.waitsOn.map((x: any) => [x.code, x.distance])).toEqual([[t(2), 1], [t(1), 2]]);

      await api().post(`/projects/${project}/tasks/${t(3)}/start`).set(auth(admin)).expect(409);
      await api().post(`/projects/${project}/tasks/${t(1)}/complete`).set(auth(admin)).expect(409);
      await api().post(`/projects/${project}/tasks/${t(1)}/start`).set(auth(admin)).expect(200);
      await api().post(`/projects/${project}/tasks/${t(1)}/complete`).set(auth(admin)).expect(200);
      await api().post(`/projects/${project}/tasks/${t(2)}/start`).set(auth(admin)).expect(200);
      // T1 cannot be reopened: T2 (which waits on it) has started
      await api().post(`/projects/${project}/tasks/${t(1)}/reopen`).set(auth(admin)).expect(409);

      const list = await api().get(`/projects/${project}/tasks`).query({ blocked: true }).set(auth(admin)).expect(200);
      expect(list.body.data.map((x: any) => x.code)).toContain(t(3));
    });

    it('task IDs are never reused after deletion', async () => {
      await api().delete(`/projects/${project}/tasks/${t(20)}`).set(auth(admin)).expect(204);
      const r = await api().post(`/projects/${project}/tasks`).set(auth(admin)).send({ name: 'After delete', plannedStart: '2026-02-01', plannedEnd: '2026-03-01' }).expect(201);
      expect(r.body.code).toBe(t(21));
    });
  });

  describe('materials and deliveries', () => {
    let materialId: number;

    beforeAll(async () => {
      await api().post('/materials').set(auth(member)).send({ name: 'x', category: 'y', unit: 'z' }).expect(403);
      const m = await api().post('/materials').set(auth(store)).send({ name: `Cement ${run}`, category: 'Cement', unit: 'bag' }).expect(201);
      materialId = m.body.id;
      await api().post('/company-store/stock').set(auth(store)).send({ lines: [{ materialId, quantity: 100 }] }).expect(201);
    });

    it('send -> in transit -> record; insufficient stock is rejected', async () => {
      await api().post('/company-store/deliveries').set(auth(store)).send({ projectCode: project, lines: [{ materialId, quantity: 1000 }] }).expect(409);
      const d = await api().post('/company-store/deliveries').set(auth(store)).send({ projectCode: project, lines: [{ materialId, quantity: 30 }] }).expect(201);
      expect(d.body.status).toBe('IN_TRANSIT');
      const stock = await api().get('/company-store/stock').query({ search: `Cement ${run}` }).set(auth(store)).expect(200);
      expect(Number(stock.body.data[0].quantity)).toBe(70);
      expect(Number(stock.body.data[0].inTransitToProjects)).toBe(30);
      // only the receiving side records
      await api().post(`/company-store/deliveries/${d.body.id}/record`).set(auth(store)).expect(403);
      await api().post(`/projects/${project}/deliveries/${d.body.id}/record`).set(auth(member)).expect(200);
      await api().post(`/projects/${project}/deliveries/${d.body.id}/reject`).set(auth(member)).expect(409);
      const ps = await api().get(`/projects/${project}/store`).set(auth(member)).expect(200);
      expect(Number(ps.body.data[0].quantity)).toBe(30);
    });

    it('concurrent deliveries never drive stock negative', async () => {
      // 70 left in the company store; 10 parallel requests of 10 => exactly 7 succeed
      const res = await Promise.all(
        Array.from({ length: 10 }, () =>
          api().post('/company-store/deliveries').set(auth(store)).send({ projectCode: project, lines: [{ materialId, quantity: 10 }] }),
        ),
      );
      expect(res.filter((r) => r.status === 201)).toHaveLength(7);
      expect(res.filter((r) => r.status === 409)).toHaveLength(3);
      const stock = await api().get('/company-store/stock').query({ search: `Cement ${run}` }).set(auth(store)).expect(200);
      expect(Number(stock.body.data[0].quantity)).toBe(0);
      expect(stock.body.data[0].status).toBe('OUT_OF_STOCK');
    });

    it('cancel returns stock to the sender', async () => {
      const ds = await api().get(`/projects/${project}/deliveries`).query({ status: 'IN_TRANSIT' }).set(auth(member)).expect(200);
      const id = ds.body.data[0].id;
      await api().post(`/company-store/deliveries/${id}/cancel`).set(auth(store)).expect(200);
      const stock = await api().get('/company-store/stock').query({ search: `Cement ${run}` }).set(auth(store)).expect(200);
      expect(Number(stock.body.data[0].quantity)).toBe(10);
    });
  });
});
