import { Edge, GraphTask, isLate, ProjectGraph, Status } from './project-graph';

const t = (id: number, status: Status = 'NOT_STARTED', plannedStart = '2030-01-01', plannedEnd = '2030-02-01'): GraphTask => ({
  id,
  code: `T-${id}`,
  name: `Task ${id}`,
  status,
  plannedStart,
  plannedEnd,
});
const e = (taskId: number, dependsOnId: number): Edge => ({ taskId, dependsOnId });

describe('ProjectGraph', () => {
  it('chain: C -> B -> A blocks C on both, with distances', () => {
    const g = new ProjectGraph([t(1), t(2), t(3)], [e(2, 1), e(3, 2)]);
    expect(g.isBlocked(3)).toBe(true);
    expect(g.isBlocked(1)).toBe(false);
    expect(g.waitsOn(3).map((r) => [r.task.id, r.distance])).toEqual([[2, 1], [1, 2]]);
    expect(g.waitedOnBy(1).map((r) => [r.task.id, r.distance])).toEqual([[2, 1], [3, 2]]);
  });

  it('chain: C stays blocked while A is unfinished even if B is done', () => {
    const g = new ProjectGraph([t(1, 'IN_PROGRESS'), t(2, 'DONE'), t(3)], [e(2, 1), e(3, 2)]);
    expect(g.isBlocked(3)).toBe(true);
    expect(g.checkAction(3, 'start')).toMatch(/T-1/);
  });

  it('side by side: C waits on both A and B', () => {
    const g = new ProjectGraph([t(1, 'DONE'), t(2, 'IN_PROGRESS'), t(3)], [e(3, 1), e(3, 2)]);
    expect(g.isBlocked(3)).toBe(true);
    expect(g.allowedActions(3)).toEqual([]);
    const g2 = new ProjectGraph([t(1, 'DONE'), t(2, 'DONE'), t(3)], [e(3, 1), e(3, 2)]);
    expect(g2.isBlocked(3)).toBe(false);
    expect(g2.allowedActions(3)).toEqual(['start']);
  });

  it('shortest distance is reported when a task is reachable by several paths', () => {
    const g = new ProjectGraph([t(1), t(2), t(3)], [e(3, 1), e(3, 2), e(2, 1)]);
    expect(g.waitsOn(3).find((r) => r.task.id === 1)!.distance).toBe(1);
  });

  it('a done task is never blocked', () => {
    const g = new ProjectGraph([t(1), t(2, 'DONE')], [e(2, 1)]);
    expect(g.isBlocked(2)).toBe(false);
  });

  it('detects cycles: self, direct and indirect', () => {
    const g = new ProjectGraph([t(1), t(2), t(3)], [e(2, 1), e(3, 2)]);
    expect(g.wouldCreateCycle(1, 1)).toBe(true);
    expect(g.wouldCreateCycle(1, 2)).toBe(true);
    expect(g.wouldCreateCycle(1, 3)).toBe(true);
    expect(g.wouldCreateCycle(3, 1)).toBe(false);
  });

  it('status machine: complete only from in progress, reopen only while no dependent started', () => {
    const g = new ProjectGraph([t(1, 'DONE'), t(2, 'NOT_STARTED'), t(3, 'NOT_STARTED')], [e(2, 1), e(3, 2)]);
    expect(g.allowedActions(1)).toEqual(['reopen']);
    const g2 = new ProjectGraph([t(1, 'DONE'), t(2, 'DONE'), t(3, 'IN_PROGRESS')], [e(2, 1), e(3, 2)]);
    expect(g2.checkAction(1, 'reopen')).toMatch(/already started/);
    expect(g2.allowedActions(3)).toEqual(['complete']);
    expect(g2.checkAction(3, 'start')).not.toBeNull();
  });

  it('handles long chains without recursion limits', () => {
    const n = 20000;
    const tasks = Array.from({ length: n }, (_, i) => t(i + 1, i === 0 ? 'IN_PROGRESS' : 'NOT_STARTED'));
    const edges = Array.from({ length: n - 1 }, (_, i) => e(i + 2, i + 1));
    const g = new ProjectGraph(tasks, edges);
    expect(g.isBlocked(n)).toBe(true);
  });
});

describe('isLate', () => {
  const today = '2026-06-15';
  it('not done and end passed', () => expect(isLate(t(1, 'IN_PROGRESS', '2026-06-01', '2026-06-14'), today)).toBe(true));
  it('not started and start passed', () => expect(isLate(t(1, 'NOT_STARTED', '2026-06-14', '2026-07-01'), today)).toBe(true));
  it('in progress, start passed but end not passed', () => expect(isLate(t(1, 'IN_PROGRESS', '2026-06-01', '2026-06-15'), today)).toBe(false));
  it('start date is today is not late', () => expect(isLate(t(1, 'NOT_STARTED', '2026-06-15', '2026-07-01'), today)).toBe(false));
  it('done is never late', () => expect(isLate(t(1, 'DONE', '2020-01-01', '2020-01-02'), today)).toBe(false));
});
