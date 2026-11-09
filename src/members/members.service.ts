import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser } from '../common/auth-user';
import { paged } from '../common/util';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { InviteDto, MarkReadDto, NotificationsQueryDto } from './members.dto';

type Tx = Prisma.TransactionClient;

@Injectable()
export class MembersService {
  constructor(private readonly prisma: PrismaService, private readonly access: ProjectAccessService) {}

  /** Members + unanswered invitations of a project (any member may view). */
  async list(user: AuthUser, code: string) {
    const { project, isAdmin } = await this.access.resolve(user, code);
    const [members, invitations] = await Promise.all([
      this.prisma.projectMember.findMany({
        where: { projectId: project.id },
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: [{ isAdmin: 'desc' }, { joinedAt: 'asc' }],
      }),
      this.prisma.invitation.findMany({
        where: { projectId: project.id, status: 'PENDING' },
        include: { invitee: { select: { id: true, name: true, email: true } }, invitedBy: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return {
      project: { code: project.code, name: project.name },
      callerIsAdmin: isAdmin,
      members: members.map((m) => ({ userId: m.userId, name: m.user.name, email: m.user.email, isAdmin: m.isAdmin, joinedAt: m.joinedAt })),
      pendingInvitations: invitations.map((i) => ({
        id: i.id,
        invitee: i.invitee,
        invitedBy: i.invitedBy,
        createdAt: i.createdAt,
      })),
    };
  }

  async invite(user: AuthUser, code: string, dto: InviteDto) {
    const { project } = await this.access.resolve(user, code, { requireAdmin: true });
    if (dto.userId === undefined && !dto.email) throw new BadRequestException('Provide userId or email');
    const invitee = await this.prisma.user.findFirst({
      where: dto.userId !== undefined ? { id: dto.userId } : { email: dto.email },
      select: { id: true, name: true, email: true },
    });
    if (!invitee) throw new NotFoundException('User not found');
    const member = await this.prisma.projectMember.findUnique({ where: { projectId_userId: { projectId: project.id, userId: invitee.id } } });
    if (member) throw new ConflictException('User is already a member of this project');
    try {
      const inv = await this.prisma.invitation.create({
        data: { projectId: project.id, inviteeId: invitee.id, invitedById: user.id },
      });
      return { id: inv.id, invitee, status: inv.status, createdAt: inv.createdAt };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('User already has a pending invitation to this project');
      }
      throw e;
    }
  }

  async withdraw(user: AuthUser, code: string, invitationId: number) {
    const { project } = await this.access.resolve(user, code, { requireAdmin: true });
    const { count } = await this.prisma.invitation.updateMany({
      where: { id: invitationId, projectId: project.id, status: 'PENDING' },
      data: { status: 'WITHDRAWN', respondedAt: new Date() },
    });
    if (count === 0) {
      const exists = await this.prisma.invitation.findFirst({ where: { id: invitationId, projectId: project.id } });
      if (!exists) throw new NotFoundException('Invitation not found');
      throw new ConflictException('Invitation has already been answered or withdrawn');
    }
  }

  async setAdmin(user: AuthUser, code: string, targetUserId: number, isAdmin: boolean) {
    const { project } = await this.access.resolve(user, code, { requireAdmin: true });
    await this.prisma.$transaction(async (tx) => {
      await this.lockProject(tx, project.id);
      const target = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId: project.id, userId: targetUserId } } });
      if (!target) throw new NotFoundException('Member not found');
      if (target.isAdmin && !isAdmin) await this.assertAnotherAdmin(tx, project.id, targetUserId);
      await tx.projectMember.update({ where: { projectId_userId: { projectId: project.id, userId: targetUserId } }, data: { isAdmin } });
    });
    return this.list(user, code);
  }

  async remove(user: AuthUser, code: string, targetUserId: number) {
    const { project } = await this.access.resolve(user, code, { requireAdmin: true });
    await this.prisma.$transaction(async (tx) => {
      await this.lockProject(tx, project.id);
      const target = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId: project.id, userId: targetUserId } } });
      if (!target) throw new NotFoundException('Member not found');
      if (target.isAdmin) await this.assertAnotherAdmin(tx, project.id, targetUserId);
      await tx.projectMember.delete({ where: { projectId_userId: { projectId: project.id, userId: targetUserId } } });
    });
  }

  // ---- notifications (the invitee's side) ----

  async notifications(user: AuthUser, q: NotificationsQueryDto) {
    const where: Prisma.InvitationWhereInput = { inviteeId: user.id, status: { not: 'WITHDRAWN' }, project: { deletedAt: null } };
    const [rows, total, unread] = await Promise.all([
      this.prisma.invitation.findMany({
        where,
        include: { project: { select: { code: true, name: true } }, invitedBy: { select: { id: true, name: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.invitation.count({ where }),
      this.unreadCount(user),
    ]);
    const data = rows.map((i) => ({
      id: i.id,
      type: 'PROJECT_INVITATION',
      project: i.project,
      invitedBy: i.invitedBy,
      status: i.status,
      createdAt: i.createdAt,
      respondedAt: i.respondedAt,
      read: i.readAt !== null,
      canRespond: i.status === 'PENDING',
    }));
    return { ...paged(data, total, q), unread: unread.unread };
  }

  async unreadCount(user: AuthUser) {
    const unread = await this.prisma.invitation.count({
      where: { inviteeId: user.id, status: 'PENDING', readAt: null, project: { deletedAt: null } },
    });
    return { unread };
  }

  async markRead(user: AuthUser, dto: MarkReadDto) {
    await this.prisma.invitation.updateMany({
      where: { inviteeId: user.id, readAt: null, ...(dto.ids ? { id: { in: dto.ids } } : {}) },
      data: { readAt: new Date() },
    });
    return this.unreadCount(user);
  }

  /** Only the invited person can answer. Joining happens atomically with accepting. */
  async respond(user: AuthUser, invitationId: number, accept: boolean) {
    return this.prisma.$transaction(async (tx) => {
      const inv = await tx.invitation.findFirst({
        where: { id: invitationId, inviteeId: user.id, project: { deletedAt: null } },
        include: { project: { select: { code: true, name: true } } },
      });
      if (!inv) throw new NotFoundException('Invitation not found');
      const now = new Date();
      const { count } = await tx.invitation.updateMany({
        where: { id: inv.id, status: 'PENDING' },
        data: { status: accept ? 'ACCEPTED' : 'REJECTED', respondedAt: now, readAt: inv.readAt ?? now },
      });
      if (count === 0) throw new ConflictException('Invitation has already been answered or withdrawn');
      if (accept) {
        await tx.projectMember.createMany({ data: [{ projectId: inv.projectId, userId: user.id }], skipDuplicates: true });
      }
      return { id: inv.id, status: accept ? 'ACCEPTED' : 'REJECTED', project: inv.project };
    });
  }

  private async lockProject(tx: Tx, projectId: number) {
    await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`;
  }

  private async assertAnotherAdmin(tx: Tx, projectId: number, exceptUserId: number) {
    const others = await tx.projectMember.count({ where: { projectId, isAdmin: true, userId: { not: exceptUserId } } });
    if (others === 0) throw new ConflictException('A project must always have at least one project admin');
  }
}
