import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser } from '../common/auth-user';
import { likeEscape, pad4, paged, parseDate, todayStr, toDateStr } from '../common/util';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectGraph, Status } from '../tasks/project-graph';
import { ProjectAccessService } from './project-access.service';
import { CreateProjectDto, ListProjectsQueryDto, UpdateProjectDto } from './projects.dto';

interface ProjectRow {
  id: number;
  code: string;
  name: string;
  planned_start: Date;
  planned_end: Date;
  is_admin: boolean;
  total: number;
  not_started: number;
  in_progress: number;
  done: number;
  late: number;
  percent_done: number;
  member_count: number;
  total_rows: number;
}

const SORT_SQL: Record<string, string> = {
  name: 'lower(j.name)',
  startDate: 'j.planned_start',
  percentDone: 'j.percent_done',
  lateTasks: 'j.late',
};

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService, private readonly access: ProjectAccessService) {}

  async create(user: AuthUser, dto: CreateProjectDto) {
    const start = parseDate(dto.plannedStart, 'plannedStart');
    const end = parseDate(dto.plannedEnd, 'plannedEnd');
    if (start > end) throw new BadRequestException('plannedEnd must be on or after plannedStart');

    const project = await this.prisma.$transaction(async (tx) => {
      const [{ n }] = await tx.$queryRaw<{ n: number }[]>`SELECT nextval('project_number_seq')::int AS n`;
      return tx.project.create({
        data: {
          number: n,
          code: `PRJ-${pad4(n)}`,
          name: dto.name.trim(),
          plannedStart: start,
          plannedEnd: end,
          createdById: user.id,
          members: { create: { userId: user.id, isAdmin: true } },
          store: { create: { kind: 'PROJECT' } },
        },
      });
    });
    return this.getOne(user, project.code);
  }

  async list(user: AuthUser, q: ListProjectsQueryDto) {
    const conds: Prisma.Sql[] = [];
    if (q.search) {
      const s = `%${likeEscape(q.search.trim())}%`;
      conds.push(Prisma.sql`(p.name ILIKE ${s} OR p.code ILIKE ${s})`);
    }
    const sortExpr = SORT_SQL[q.sort ?? 'name'];
    const order = q.order === 'desc' ? 'DESC' : 'ASC';
    const rows = await this.queryProjects(user, conds, {
      hasLate: !!q.hasLateTasks,
      orderBy: Prisma.raw(`${sortExpr} ${order} NULLS LAST, j.id ${order}`),
      limit: q.pageSize,
      offset: (q.page - 1) * q.pageSize,
    });
    const total = rows[0]?.total_rows ?? (q.page > 1 ? await this.countOnly(user, conds, !!q.hasLateTasks) : 0);
    return paged(await this.withBlocked(rows), total, q);
  }

  async getOne(user: AuthUser, code: string) {
    const { project } = await this.access.resolve(user, code);
    const rows = await this.queryProjects(user, [Prisma.sql`p.id = ${project.id}`], {
      hasLate: false,
      orderBy: Prisma.raw('j.id'),
      limit: 1,
      offset: 0,
      forceVisible: true,
    });
    if (!rows.length) throw new NotFoundException('Project not found');
    return (await this.withBlocked(rows))[0];
  }

  async update(user: AuthUser, code: string, dto: UpdateProjectDto) {
    const { project } = await this.access.resolve(user, code, { requireAdmin: true });
    const start = dto.plannedStart ? parseDate(dto.plannedStart, 'plannedStart') : project.plannedStart;
    const end = dto.plannedEnd ? parseDate(dto.plannedEnd, 'plannedEnd') : project.plannedEnd;
    if (start > end) throw new BadRequestException('plannedEnd must be on or after plannedStart');
    await this.prisma.project.update({
      where: { id: project.id },
      data: { name: dto.name?.trim(), plannedStart: start, plannedEnd: end },
    });
    return this.getOne(user, project.code);
  }

  async remove(user: AuthUser, code: string) {
    const { project } = await this.access.resolve(user, code, { requireAdmin: true });
    const inTransit = await this.prisma.delivery.count({ where: { projectId: project.id, status: 'IN_TRANSIT' } });
    if (inTransit > 0) throw new ConflictException('Project has deliveries in transit; record, reject or cancel them first');
    await this.prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });
  }

  /**
   * One SQL statement that applies visibility, search, the late filter, sorting and paging.
   * Task counts and the Late count are aggregated in SQL; Late uses today's date.
   */
  private async queryProjects(
    user: AuthUser,
    extra: Prisma.Sql[],
    o: { hasLate: boolean; orderBy: Prisma.Sql; limit: number; offset: number; forceVisible?: boolean },
  ): Promise<ProjectRow[]> {
    const today = todayStr();
    const seeAll = user.role === 'SUPER_ADMIN' || o.forceVisible;
    const conds = [Prisma.sql`p.deleted_at IS NULL`, ...(seeAll ? [] : [Prisma.sql`m.user_id IS NOT NULL`]), ...extra];
    return this.prisma.$queryRaw<ProjectRow[]>`
      WITH visible AS (
        SELECT p.id, p.code, p.name, p.planned_start, p.planned_end, coalesce(m.is_admin, false) AS is_admin
        FROM projects p
        LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = ${user.id}
        WHERE ${Prisma.join(conds, ' AND ')}
      ), stats AS (
        SELECT t.project_id,
               count(*)::int AS total,
               count(*) FILTER (WHERE t.status = 'NOT_STARTED')::int AS not_started,
               count(*) FILTER (WHERE t.status = 'IN_PROGRESS')::int AS in_progress,
               count(*) FILTER (WHERE t.status = 'DONE')::int AS done,
               count(*) FILTER (WHERE t.status <> 'DONE' AND (t.planned_end < ${today}::date
                                 OR (t.status = 'NOT_STARTED' AND t.planned_start < ${today}::date)))::int AS late
        FROM tasks t
        WHERE t.project_id IN (SELECT id FROM visible)
        GROUP BY t.project_id
      ), joined AS (
        SELECT v.*, coalesce(s.total, 0) AS total, coalesce(s.not_started, 0) AS not_started,
               coalesce(s.in_progress, 0) AS in_progress, coalesce(s.done, 0) AS done, coalesce(s.late, 0) AS late,
               CASE WHEN coalesce(s.total, 0) = 0 THEN 0 ELSE round(100.0 * s.done / s.total, 1)::float8 END AS percent_done
        FROM visible v LEFT JOIN stats s ON s.project_id = v.id
      ), page AS (
        SELECT j.*, count(*) OVER ()::int AS total_rows
        FROM joined j
        WHERE ${o.hasLate ? Prisma.sql`j.late > 0` : Prisma.sql`TRUE`}
        ORDER BY ${o.orderBy}
        LIMIT ${o.limit} OFFSET ${o.offset}
      )
      SELECT page.*, (SELECT count(*)::int FROM project_members pm WHERE pm.project_id = page.id) AS member_count
      FROM page
      ORDER BY ${Prisma.raw(o.orderBy.sql.replace(/\bj\./g, 'page.'))}`;
  }

  private async countOnly(user: AuthUser, extra: Prisma.Sql[], hasLate: boolean) {
    const rows = await this.queryProjects(user, extra, { hasLate, orderBy: Prisma.raw('j.id'), limit: 1, offset: 0 });
    return rows[0]?.total_rows ?? 0;
  }

  /** Blocked counts are only needed for the rows on the page, so they are computed for those only. */
  private async withBlocked(rows: ProjectRow[]) {
    const ids = rows.map((r) => r.id);
    const blocked = new Map<number, number>();
    if (ids.length) {
      // Load only (id, status) and edges for the page's projects and evaluate with the same graph
      // rules the task screens use. Much faster than a recursive CTE over the dependency table.
      const [tasks, edges] = await Promise.all([
        this.prisma.$queryRaw<{ id: number; project_id: number; status: Status }[]>`
          SELECT id, project_id, status::text AS status FROM tasks WHERE project_id = ANY(${ids}::int[])`,
        this.prisma.$queryRaw<{ taskId: number; dependsOnId: number }[]>`
          SELECT task_id AS "taskId", depends_on_id AS "dependsOnId" FROM task_dependencies WHERE project_id = ANY(${ids}::int[])`,
      ]);
      const g = new ProjectGraph(
        tasks.map((t) => ({ id: t.id, code: String(t.id), name: '', status: t.status, plannedStart: '', plannedEnd: '' })),
        edges,
      );
      for (const t of tasks) if (g.isBlocked(t.id)) blocked.set(t.project_id, (blocked.get(t.project_id) ?? 0) + 1);
    }
    return rows.map((r) => ({
      code: r.code,
      name: r.name,
      plannedStart: toDateStr(r.planned_start),
      plannedEnd: toDateStr(r.planned_end),
      isAdmin: r.is_admin,
      memberCount: r.member_count,
      taskCounts: { notStarted: r.not_started, inProgress: r.in_progress, done: r.done, total: r.total },
      percentDone: r.percent_done,
      lateTasks: r.late,
      blockedTasks: blocked.get(r.id) ?? 0,
    }));
  }
}
