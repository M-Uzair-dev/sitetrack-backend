import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser } from '../common/auth-user';
import { pad4, paged, parseDate, todayStr } from '../common/util';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { GraphTask, isLate, ProjectGraph, TaskAction } from './project-graph';
import { AddDependencyDto, CreateTaskDto, ListTasksQueryDto, UpdateTaskDto } from './tasks.dto';

type Db = PrismaService | Prisma.TransactionClient;

@Injectable()
export class TasksService {
  constructor(private readonly prisma: PrismaService, private readonly access: ProjectAccessService) {}

  /** Loads all tasks and dependency edges of one project (two indexed queries). */
  async loadGraph(projectId: number, db: Db = this.prisma): Promise<ProjectGraph> {
    const [tasks, edges] = await Promise.all([
      db.$queryRaw<GraphTask[]>`
        SELECT id, code, name, status::text AS status,
               to_char(planned_start, 'YYYY-MM-DD') AS "plannedStart",
               to_char(planned_end, 'YYYY-MM-DD') AS "plannedEnd"
        FROM tasks WHERE project_id = ${projectId}`,
      db.$queryRaw<{ taskId: number; dependsOnId: number }[]>`
        SELECT task_id AS "taskId", depends_on_id AS "dependsOnId" FROM task_dependencies WHERE project_id = ${projectId}`,
    ]);
    return new ProjectGraph(tasks, edges);
  }

  async list(user: AuthUser, code: string, q: ListTasksQueryDto) {
    const { project } = await this.access.resolve(user, code);
    const g = await this.loadGraph(project.id);
    const today = todayStr();
    let rows = [...g.tasks.values()].map((t) => this.summary(g, t, today));

    if (q.status?.length) rows = rows.filter((r) => q.status!.includes(r.status));
    if (q.late !== undefined) rows = rows.filter((r) => r.late === q.late);
    if (q.blocked !== undefined) rows = rows.filter((r) => r.blocked === q.blocked);
    if (q.from) rows = rows.filter((r) => r.plannedEnd >= q.from!);
    if (q.to) rows = rows.filter((r) => r.plannedStart <= q.to!);
    if (q.search) {
      const s = q.search.trim().toLowerCase();
      rows = rows.filter((r) => r.name.toLowerCase().includes(s) || r.code.toLowerCase().includes(s));
    }

    const dir = q.order === 'desc' ? -1 : 1;
    const key = q.sort ?? 'code';
    const cmp: Record<string, (a: (typeof rows)[0], b: (typeof rows)[0]) => number> = {
      code: (a, b) => a.number - b.number,
      name: (a, b) => a.name.localeCompare(b.name),
      startDate: (a, b) => a.plannedStart.localeCompare(b.plannedStart),
      endDate: (a, b) => a.plannedEnd.localeCompare(b.plannedEnd),
      dependentsCount: (a, b) => a.dependentsCount - b.dependentsCount,
    };
    rows.sort((a, b) => dir * (cmp[key](a, b) || a.number - b.number));

    const start = (q.page - 1) * q.pageSize;
    return paged(
      rows.slice(start, start + q.pageSize).map(({ number: _n, ...r }) => r),
      rows.length,
      q,
    );
  }

  async detail(user: AuthUser, code: string, taskCode: string) {
    const { project } = await this.access.resolve(user, code);
    const g = await this.loadGraph(project.id);
    const t = this.find(g, taskCode);
    const today = todayStr();
    const reached = (rs: ReturnType<ProjectGraph['waitsOn']>) =>
      rs.map((r) => ({
        code: r.task.code,
        name: r.task.name,
        status: r.task.status,
        late: isLate(r.task, today),
        blocked: g.isBlocked(r.task.id),
        distance: r.distance,
      }));
    const { number: _n, ...summary } = this.summary(g, t, today);
    const row = await this.prisma.task.findUniqueOrThrow({ where: { id: t.id }, select: { startedAt: true, doneAt: true, createdAt: true } });
    return {
      ...summary,
      ...row,
      allowedActions: g.allowedActions(t.id),
      waitsOn: reached(g.waitsOn(t.id)),
      waitedOnBy: reached(g.waitedOnBy(t.id)),
    };
  }

  async create(user: AuthUser, code: string, dto: CreateTaskDto) {
    const { project } = await this.access.resolve(user, code);
    const start = parseDate(dto.plannedStart, 'plannedStart');
    const end = parseDate(dto.plannedEnd, 'plannedEnd');
    if (start > end) throw new BadRequestException('plannedEnd must be on or after plannedStart');
    const depCodes = [...new Set((dto.dependsOn ?? []).map((c) => c.toUpperCase()))];

    const taskCode = await this.prisma.$transaction(async (tx) => {
      if (depCodes.length) await this.lock(tx, project.id);
      // Row-level lock on the project serialises concurrent creates; the counter never goes back.
      const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
        UPDATE projects SET next_task_number = next_task_number + 1 WHERE id = ${project.id}
        RETURNING next_task_number - 1 AS n`;
      const task = await tx.task.create({
        data: { projectId: project.id, number: n, code: `${project.code}-T-${pad4(n)}`, name: dto.name.trim(), plannedStart: start, plannedEnd: end },
      });
      if (depCodes.length) {
        const deps = await tx.task.findMany({ where: { projectId: project.id, code: { in: depCodes } }, select: { id: true, code: true } });
        const missing = depCodes.filter((c) => !deps.some((d) => d.code === c));
        if (missing.length) throw new NotFoundException(`Task(s) not found in this project: ${missing.join(', ')}`);
        // A brand-new task has no dependents, so these edges cannot form a cycle.
        await tx.taskDependency.createMany({ data: deps.map((d) => ({ taskId: task.id, dependsOnId: d.id, projectId: project.id })) });
      }
      return task.code;
    });
    return this.detail(user, code, taskCode);
  }

  async update(user: AuthUser, code: string, taskCode: string, dto: UpdateTaskDto) {
    const { project } = await this.access.resolve(user, code);
    const task = await this.prisma.task.findFirst({ where: { projectId: project.id, code: taskCode.toUpperCase() } });
    if (!task) throw new NotFoundException('Task not found');
    const start = dto.plannedStart ? parseDate(dto.plannedStart, 'plannedStart') : task.plannedStart;
    const end = dto.plannedEnd ? parseDate(dto.plannedEnd, 'plannedEnd') : task.plannedEnd;
    if (start > end) throw new BadRequestException('plannedEnd must be on or after plannedStart');
    await this.prisma.task.update({ where: { id: task.id }, data: { name: dto.name?.trim(), plannedStart: start, plannedEnd: end } });
    return this.detail(user, code, task.code);
  }

  async remove(user: AuthUser, code: string, taskCode: string) {
    const { project } = await this.access.resolve(user, code);
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, project.id);
      const { count } = await tx.task.deleteMany({ where: { projectId: project.id, code: taskCode.toUpperCase() } });
      if (count === 0) throw new NotFoundException('Task not found');
    });
  }

  async action(user: AuthUser, code: string, taskCode: string, action: TaskAction) {
    const { project } = await this.access.resolve(user, code);
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, project.id);
      const g = await this.loadGraph(project.id, tx);
      const t = this.find(g, taskCode);
      const reason = g.checkAction(t.id, action);
      if (reason) throw new ConflictException(reason);
      const now = new Date();
      const data =
        action === 'start'
          ? { status: 'IN_PROGRESS' as const, startedAt: now }
          : action === 'complete'
            ? { status: 'DONE' as const, doneAt: now }
            : { status: 'IN_PROGRESS' as const, doneAt: null };
      await tx.task.update({ where: { id: t.id }, data });
    });
    return this.detail(user, code, taskCode);
  }

  async addDependency(user: AuthUser, code: string, taskCode: string, dto: AddDependencyDto) {
    const { project } = await this.access.resolve(user, code);
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, project.id);
      const g = await this.loadGraph(project.id, tx);
      const t = this.find(g, taskCode);
      const dep = g.byCode.get(dto.dependsOn.toUpperCase());
      if (!dep) throw new NotFoundException('Dependency task not found in this project');
      if ((g.deps.get(t.id) ?? []).includes(dep.id)) throw new ConflictException('This dependency already exists');
      if (g.wouldCreateCycle(t.id, dep.id)) throw new ConflictException('Dependency would make the task wait on itself (cycle)');
      await tx.taskDependency.create({ data: { taskId: t.id, dependsOnId: dep.id, projectId: project.id } });
    });
    return this.detail(user, code, taskCode);
  }

  async removeDependency(user: AuthUser, code: string, taskCode: string, dependsOnCode: string) {
    const { project } = await this.access.resolve(user, code);
    const [task, dep] = await Promise.all([
      this.prisma.task.findFirst({ where: { projectId: project.id, code: taskCode.toUpperCase() }, select: { id: true } }),
      this.prisma.task.findFirst({ where: { projectId: project.id, code: dependsOnCode.toUpperCase() }, select: { id: true } }),
    ]);
    if (!task || !dep) throw new NotFoundException('Task not found');
    const { count } = await this.prisma.taskDependency.deleteMany({ where: { taskId: task.id, dependsOnId: dep.id } });
    if (count === 0) throw new NotFoundException('Dependency not found');
  }

  private summary(g: ProjectGraph, t: GraphTask, today: string) {
    return {
      code: t.code,
      number: Number(t.code.slice(t.code.lastIndexOf('-') + 1)),
      name: t.name,
      plannedStart: t.plannedStart,
      plannedEnd: t.plannedEnd,
      status: t.status,
      late: isLate(t, today),
      blocked: g.isBlocked(t.id),
      dependsOn: g.directDeps(t.id).map((d) => ({ code: d.code, name: d.name, status: d.status })),
      dependentsCount: g.dependentsCount(t.id),
    };
  }

  private find(g: ProjectGraph, taskCode: string): GraphTask {
    const t = g.byCode.get(String(taskCode).toUpperCase());
    if (!t) throw new NotFoundException('Task not found');
    return t;
  }

  /** Serialises graph-changing writes within one project (cycle checks, start/reopen rules). */
  private async lock(tx: Prisma.TransactionClient, projectId: number) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1, ${projectId}::int)`;
  }
}

