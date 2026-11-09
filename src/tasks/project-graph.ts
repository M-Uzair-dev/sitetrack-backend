export type Status = 'NOT_STARTED' | 'IN_PROGRESS' | 'DONE';
export type TaskAction = 'start' | 'complete' | 'reopen';

export interface GraphTask {
  id: number;
  code: string;
  name: string;
  status: Status;
  /** YYYY-MM-DD */
  plannedStart: string;
  /** YYYY-MM-DD */
  plannedEnd: string;
}

export interface Edge {
  /** the waiting task */
  taskId: number;
  /** the task it waits for */
  dependsOnId: number;
}

export interface Reached {
  task: GraphTask;
  /** number of dependency steps away (1 = direct) */
  distance: number;
}

/**
 * In-memory dependency graph of a single project. A project holds at most a few thousand
 * tasks, so loading its tasks + edges (two indexed queries) and walking the graph in memory
 * is fast and keeps every derived rule (Blocked, allowed actions, cycles, distances) in one place.
 */
export class ProjectGraph {
  readonly tasks = new Map<number, GraphTask>();
  readonly byCode = new Map<string, GraphTask>();
  /** task -> tasks it waits on directly */
  readonly deps = new Map<number, number[]>();
  /** task -> tasks that wait on it directly */
  readonly dependents = new Map<number, number[]>();
  private waitingMemo = new Map<number, boolean>();

  constructor(tasks: GraphTask[], edges: Edge[]) {
    for (const t of tasks) {
      this.tasks.set(t.id, t);
      this.byCode.set(t.code, t);
    }
    for (const e of edges) {
      if (!this.tasks.has(e.taskId) || !this.tasks.has(e.dependsOnId)) continue;
      push(this.deps, e.taskId, e.dependsOnId);
      push(this.dependents, e.dependsOnId, e.taskId);
    }
  }

  directDeps(id: number): GraphTask[] {
    return (this.deps.get(id) ?? []).map((d) => this.tasks.get(d)!);
  }

  dependentsCount(id: number): number {
    return this.dependents.get(id)?.length ?? 0;
  }

  /** True when at least one task reachable through dependencies is not done. */
  hasUnfinishedPrerequisite(id: number): boolean {
    if (!this.waitingMemo.has(id)) this.computeWaiting(id);
    return this.waitingMemo.get(id)!;
  }

  /** Blocked (derived): not done, and something it waits on (directly or indirectly) is not done. */
  isBlocked(id: number): boolean {
    return this.tasks.get(id)!.status !== 'DONE' && this.hasUnfinishedPrerequisite(id);
  }

  /** Every task it waits on, directly or indirectly, with the shortest number of steps. */
  waitsOn(id: number): Reached[] {
    return this.bfs(id, this.deps);
  }

  /** Every task that waits on it, directly or indirectly, with the shortest number of steps. */
  waitedOnBy(id: number): Reached[] {
    return this.bfs(id, this.dependents);
  }

  /** Adding "taskId depends on dependsOnId" creates a cycle if taskId is already reachable from dependsOnId. */
  wouldCreateCycle(taskId: number, dependsOnId: number): boolean {
    if (taskId === dependsOnId) return true;
    const seen = new Set<number>([dependsOnId]);
    const queue = [dependsOnId];
    while (queue.length) {
      const cur = queue.pop()!;
      for (const next of this.deps.get(cur) ?? []) {
        if (next === taskId) return true;
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return false;
  }

  /** Returns null when the action is allowed, otherwise a human-readable reason. */
  checkAction(id: number, action: TaskAction): string | null {
    const t = this.tasks.get(id)!;
    switch (action) {
      case 'start': {
        if (t.status !== 'NOT_STARTED') return `Only a Not started task can be started (task is ${t.status})`;
        const unfinished = this.waitsOn(id).filter((r) => r.task.status !== 'DONE');
        if (unfinished.length) return `Task is waiting on unfinished tasks: ${listCodes(unfinished)}`;
        return null;
      }
      case 'complete':
        return t.status === 'IN_PROGRESS' ? null : `Only an In progress task can be marked as done (task is ${t.status})`;
      case 'reopen': {
        if (t.status !== 'DONE') return `Only a Done task can be reopened (task is ${t.status})`;
        const started = this.waitedOnBy(id).filter((r) => r.task.status !== 'NOT_STARTED');
        if (started.length) return `Tasks waiting on this one have already started: ${listCodes(started)}`;
        return null;
      }
    }
  }

  allowedActions(id: number): TaskAction[] {
    return (['start', 'complete', 'reopen'] as TaskAction[]).filter((a) => this.checkAction(id, a) === null);
  }

  private bfs(start: number, adj: Map<number, number[]>): Reached[] {
    const dist = new Map<number, number>([[start, 0]]);
    const out: Reached[] = [];
    let frontier = [start];
    for (let d = 1; frontier.length; d++) {
      const next: number[] = [];
      for (const cur of frontier) {
        for (const n of adj.get(cur) ?? []) {
          if (dist.has(n)) continue;
          dist.set(n, d);
          out.push({ task: this.tasks.get(n)!, distance: d });
          next.push(n);
        }
      }
      frontier = next;
    }
    return out.sort((a, b) => a.distance - b.distance || a.task.code.localeCompare(b.task.code));
  }

  /** Iterative post-order DFS with memoisation (no recursion, safe for long chains). */
  private computeWaiting(start: number) {
    const inProgress = new Set<number>();
    const stack: Array<[number, boolean]> = [[start, false]];
    while (stack.length) {
      const [id, expanded] = stack.pop()!;
      if (this.waitingMemo.has(id)) continue;
      const ds = this.deps.get(id) ?? [];
      if (!expanded) {
        if (inProgress.has(id)) continue; // defensive: ignore a cycle in bad data
        inProgress.add(id);
        stack.push([id, true]);
        for (const d of ds) if (!this.waitingMemo.has(d)) stack.push([d, false]);
      } else {
        let waiting = false;
        for (const d of ds) {
          if (this.tasks.get(d)!.status !== 'DONE' || this.waitingMemo.get(d)) {
            waiting = true;
            break;
          }
        }
        this.waitingMemo.set(id, waiting);
        inProgress.delete(id);
      }
    }
  }
}

/** Late (derived): not done and planned end has passed, or not started and planned start has passed. */
export function isLate(t: Pick<GraphTask, 'status' | 'plannedStart' | 'plannedEnd'>, today: string): boolean {
  if (t.status === 'DONE') return false;
  return t.plannedEnd < today || (t.status === 'NOT_STARTED' && t.plannedStart < today);
}

function push(m: Map<number, number[]>, k: number, v: number) {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

function listCodes(rs: Reached[]) {
  const codes = rs.slice(0, 5).map((r) => r.task.code);
  return codes.join(', ') + (rs.length > 5 ? ` and ${rs.length - 5} more` : '');
}
