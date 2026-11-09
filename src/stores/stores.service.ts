import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DeliveryDirection, DeliveryStatus, Prisma } from '@prisma/client';
import { AuthUser } from '../common/auth-user';
import { likeEscape, paged, parseDate, parseQty } from '../common/util';
import { PrismaService } from '../prisma/prisma.service';
import { CompanyStockQueryDto, DeliveriesQueryDto, LineDto, ProjectStockQueryDto } from './stores.dto';

type Tx = Prisma.TransactionClient;
interface Line {
  materialId: number;
  quantity: string;
}

const DELIVERY_INCLUDE = {
  project: { select: { code: true, name: true } },
  sentBy: { select: { id: true, name: true } },
  receivedBy: { select: { id: true, name: true } },
  cancelledBy: { select: { id: true, name: true } },
  lines: { select: { materialId: true, quantity: true, material: { select: { name: true, unit: true, category: true } } }, orderBy: { materialId: 'asc' } },
} satisfies Prisma.DeliveryInclude;

type DeliveryRow = Prisma.DeliveryGetPayload<{ include: typeof DELIVERY_INCLUDE }>;

@Injectable()
export class StoresService {
  private companyStoreId?: number;

  constructor(private readonly prisma: PrismaService) {}

  async getCompanyStoreId(): Promise<number> {
    if (!this.companyStoreId) {
      const s = await this.prisma.store.findFirstOrThrow({ where: { kind: 'COMPANY' }, select: { id: true } });
      this.companyStoreId = s.id;
    }
    return this.companyStoreId;
  }

  async projectStoreId(projectId: number): Promise<number> {
    const s = await this.prisma.store.findUniqueOrThrow({ where: { projectId }, select: { id: true } });
    return s.id;
  }

  // ------------------------------------------------------------------ stock views

  async companyStock(q: CompanyStockQueryDto) {
    const storeId = await this.getCompanyStoreId();
    const conds: Prisma.Sql[] = [Prisma.sql`m.deleted_at IS NULL`];
    if (q.category) conds.push(Prisma.sql`m.category = ${q.category}`);
    if (q.search) conds.push(Prisma.sql`m.name ILIKE ${'%' + likeEscape(q.search.trim()) + '%'}`);
    const statusCond = q.status?.length ? Prisma.sql`x.status = ANY(${q.status}::text[])` : Prisma.sql`TRUE`;
    const dir = q.order === 'desc' ? 'DESC' : 'ASC';
    const sort = { name: 'lower(x.name)', quantity: 'x.quantity', status: 'x.status_rank' }[q.sort ?? 'name'];
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT x.*, count(*) OVER ()::int AS total_rows FROM (
        SELECT m.id, m.name, m.category, m.unit,
               coalesce(s.quantity, 0) AS quantity,
               coalesce(s.in_transit_out, 0) AS in_transit,
               coalesce(s.reorder_point, 0) AS reorder_point,
               CASE WHEN coalesce(s.quantity, 0) = 0 THEN 'OUT_OF_STOCK'
                    WHEN coalesce(s.quantity, 0) <= coalesce(s.reorder_point, 0) THEN 'LOW_STOCK'
                    ELSE 'AVAILABLE' END AS status,
               CASE WHEN coalesce(s.quantity, 0) = 0 THEN 0
                    WHEN coalesce(s.quantity, 0) <= coalesce(s.reorder_point, 0) THEN 1 ELSE 2 END AS status_rank
        FROM materials m
        LEFT JOIN stock s ON s.material_id = m.id AND s.store_id = ${storeId}
        WHERE ${Prisma.join(conds, ' AND ')}
      ) x
      WHERE ${statusCond}
      ORDER BY ${Prisma.raw(`${sort} ${dir}, x.id ${dir}`)}
      LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`;
    return paged(
      rows.map((r) => ({
        material: { id: r.id, name: r.name, category: r.category, unit: r.unit },
        quantity: r.quantity,
        unit: r.unit,
        inTransitToProjects: r.in_transit,
        reorderPoint: r.reorder_point,
        status: r.status,
      })),
      rows[0]?.total_rows ?? 0,
      q,
    );
  }

  async projectStock(projectId: number, q: ProjectStockQueryDto) {
    const storeId = await this.projectStoreId(projectId);
    const conds: Prisma.Sql[] = [Prisma.sql`s.store_id = ${storeId}`];
    if (q.category) conds.push(Prisma.sql`m.category = ${q.category}`);
    if (q.search) conds.push(Prisma.sql`m.name ILIKE ${'%' + likeEscape(q.search.trim()) + '%'}`);
    const dir = q.order === 'desc' ? 'DESC' : 'ASC';
    const sort = { name: 'lower(m.name)', quantity: 's.quantity', lastDelivery: 's.last_movement_at' }[q.sort ?? 'name'];
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT m.id, m.name, m.category, m.unit, s.quantity, s.last_movement_at, count(*) OVER ()::int AS total_rows
      FROM stock s JOIN materials m ON m.id = s.material_id
      WHERE ${Prisma.join(conds, ' AND ')}
      ORDER BY ${Prisma.raw(`${sort} ${dir} NULLS LAST, m.id ${dir}`)}
      LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`;
    return paged(
      rows.map((r) => ({
        material: { id: r.id, name: r.name, category: r.category, unit: r.unit },
        quantity: r.quantity,
        unit: r.unit,
        lastDeliveryAt: r.last_movement_at,
      })),
      rows[0]?.total_rows ?? 0,
      q,
    );
  }

  /** Supplier -> company store. The only way new material enters SiteTrack. All lines or none. */
  async addStock(lines: LineDto[]) {
    const storeId = await this.getCompanyStoreId();
    const parsed = await this.validateLines(lines);
    await this.prisma.$transaction(async (tx) => {
      for (const l of parsed) await this.increment(tx, storeId, l.materialId, l.quantity);
    });
    return { added: parsed };
  }

  async setReorderPoint(materialId: number, value: string | number) {
    const storeId = await this.getCompanyStoreId();
    const rp = parseQty(value, 'reorderPoint', true);
    const m = await this.prisma.material.findFirst({ where: { id: materialId, deletedAt: null } });
    if (!m) throw new NotFoundException('Material not found');
    await this.prisma.$executeRaw`
      INSERT INTO stock (store_id, material_id, reorder_point) VALUES (${storeId}, ${materialId}, ${rp}::numeric)
      ON CONFLICT (store_id, material_id) DO UPDATE SET reorder_point = EXCLUDED.reorder_point`;
    return { materialId, reorderPoint: rp };
  }

  // ------------------------------------------------------------------ deliveries

  async listDeliveries(q: DeliveriesQueryDto, scope: { projectId?: number }) {
    const where: Prisma.DeliveryWhereInput = {
      ...(scope.projectId ? { projectId: scope.projectId } : {}),
      ...(q.projectCode && !scope.projectId ? { project: { code: q.projectCode.toUpperCase() } } : {}),
      ...(q.direction ? { direction: q.direction } : {}),
      ...(q.status?.length ? { status: { in: q.status as DeliveryStatus[] } } : {}),
      ...(q.from || q.to
        ? {
            sentAt: {
              ...(q.from ? { gte: parseDate(q.from, 'from') } : {}),
              ...(q.to ? { lt: new Date(parseDate(q.to, 'to').getTime() + 86_400_000) } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.delivery.findMany({
        where,
        include: DELIVERY_INCLUDE,
        orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.delivery.count({ where }),
    ]);
    return paged(rows.map((d) => this.toDto(d)), total, q);
  }

  async getDelivery(id: number, scope: { projectId?: number }) {
    const d = await this.prisma.delivery.findFirst({ where: { id, ...(scope.projectId ? { projectId: scope.projectId } : {}) }, include: DELIVERY_INCLUDE });
    if (!d) throw new NotFoundException('Delivery not found');
    return this.toDto(d);
  }

  /**
   * Sender initiates: quantities leave the sender's stock immediately and the delivery is In transit.
   * The guarded UPDATE (quantity >= q) makes negative stock impossible even under concurrency;
   * lines are processed in material order so concurrent deliveries cannot deadlock.
   */
  async initiate(direction: DeliveryDirection, projectId: number, lines: LineDto[], user: AuthUser) {
    const parsed = await this.validateLines(lines);
    const company = await this.getCompanyStoreId();
    const project = await this.projectStoreId(projectId);
    const from = direction === 'TO_PROJECT' ? company : project;
    const senderIsCompany = direction === 'TO_PROJECT';

    const id = await this.prisma.$transaction(async (tx) => {
      for (const l of parsed) {
        const n = await tx.$executeRaw`
          UPDATE stock
          SET quantity = quantity - ${l.quantity}::numeric,
              in_transit_out = in_transit_out + ${senderIsCompany ? l.quantity : '0'}::numeric,
              last_movement_at = now()
          WHERE store_id = ${from} AND material_id = ${l.materialId} AND quantity >= ${l.quantity}::numeric`;
        if (n === 0) throw new ConflictException(`Insufficient stock for material ${l.materialId} in the sending store`);
      }
      const d = await tx.delivery.create({
        data: { direction, status: 'IN_TRANSIT', projectId, sentById: user.id, lines: { create: parsed } },
        select: { id: true },
      });
      return d.id;
    });
    return this.getDelivery(id, {});
  }

  /**
   * Record / reject (receiver) or cancel (sender). A single conditional UPDATE moves the delivery
   * out of In transit, so two people acting at once cannot both succeed.
   */
  async transition(id: number, expectedDirection: DeliveryDirection, to: 'DELIVERED' | 'REJECTED' | 'CANCELLED', user: AuthUser, scope: { projectId?: number }) {
    const d = await this.prisma.delivery.findFirst({ where: { id, ...(scope.projectId ? { projectId: scope.projectId } : {}) }, select: { id: true, direction: true, projectId: true } });
    if (!d) throw new NotFoundException('Delivery not found');
    if (d.direction !== expectedDirection) {
      throw new ForbiddenException(to === 'CANCELLED' ? 'Only the sending side can cancel this delivery' : 'Only the receiving side can record or reject this delivery');
    }
    const company = await this.getCompanyStoreId();
    const project = await this.projectStoreId(d.projectId);
    const sender = d.direction === 'TO_PROJECT' ? company : project;
    const receiver = d.direction === 'TO_PROJECT' ? project : company;

    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const { count } = await tx.delivery.updateMany({
        where: { id, status: 'IN_TRANSIT' },
        data:
          to === 'CANCELLED'
            ? { status: to, cancelledById: user.id, cancelledAt: now }
            : { status: to, receivedById: user.id, receivedAt: now },
      });
      if (count === 0) throw new ConflictException('Delivery is no longer in transit');
      const lines = await tx.deliveryLine.findMany({ where: { deliveryId: id }, orderBy: { materialId: 'asc' } });
      const target = to === 'DELIVERED' ? receiver : sender;
      for (const l of lines) {
        const q = l.quantity.toString();
        await this.increment(tx, target, l.materialId, q);
        if (d.direction === 'TO_PROJECT') {
          await tx.$executeRaw`
            UPDATE stock SET in_transit_out = GREATEST(in_transit_out - ${q}::numeric, 0)
            WHERE store_id = ${company} AND material_id = ${l.materialId}`;
        }
      }
    });
    return this.getDelivery(id, {});
  }

  private async increment(tx: Tx, storeId: number, materialId: number, qty: string) {
    await tx.$executeRaw`
      INSERT INTO stock (store_id, material_id, quantity, last_movement_at)
      VALUES (${storeId}, ${materialId}, ${qty}::numeric, now())
      ON CONFLICT (store_id, material_id)
      DO UPDATE SET quantity = stock.quantity + EXCLUDED.quantity, last_movement_at = now()`;
  }

  private async validateLines(lines: LineDto[]): Promise<Line[]> {
    const parsed = lines.map((l, i) => ({ materialId: l.materialId, quantity: parseQty(l.quantity, `lines[${i}].quantity`) }));
    const ids = parsed.map((l) => l.materialId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Each material may appear only once per request');
    const found = await this.prisma.material.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true } });
    const missing = ids.filter((id) => !found.some((f) => f.id === id));
    if (missing.length) throw new BadRequestException(`Unknown material(s): ${missing.join(', ')}`);
    return parsed.sort((a, b) => a.materialId - b.materialId);
  }

  private toDto(d: DeliveryRow) {
    return {
      id: d.id,
      project: d.project,
      direction: d.direction,
      from: d.direction === 'TO_PROJECT' ? 'COMPANY_STORE' : 'PROJECT_STORE',
      to: d.direction === 'TO_PROJECT' ? 'PROJECT_STORE' : 'COMPANY_STORE',
      status: d.status,
      lines: d.lines.map((l) => ({ materialId: l.materialId, name: l.material.name, category: l.material.category, unit: l.material.unit, quantity: l.quantity })),
      sentAt: d.sentAt,
      sentBy: d.sentBy,
      receivedAt: d.receivedAt,
      receivedBy: d.receivedBy,
      cancelledAt: d.cancelledAt,
      cancelledBy: d.cancelledBy,
    };
  }
}
