import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Project } from '@prisma/client';
import { AuthUser } from '../common/auth-user';
import { PrismaService } from '../prisma/prisma.service';

export interface ProjectAccess {
  project: Project;
  isMember: boolean;
  isAdmin: boolean;
}

/**
 * The single gate for everything inside a project. Membership and admin status are
 * read from the database on every call, so removals and admin changes apply on the
 * very next request. Non-members get the same 404 as a project that does not exist.
 */
@Injectable()
export class ProjectAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(user: AuthUser, projectCode: string, opts: { requireAdmin?: boolean } = {}): Promise<ProjectAccess> {
    const project = await this.prisma.project.findFirst({
      where: { code: String(projectCode).toUpperCase(), deletedAt: null },
      include: { members: { where: { userId: user.id }, select: { isAdmin: true } } },
    });
    const membership = project?.members[0];
    if (!project || (!membership && user.role !== 'SUPER_ADMIN')) {
      throw new NotFoundException('Project not found');
    }
    const isAdmin = !!membership?.isAdmin;
    if (opts.requireAdmin && !isAdmin) throw new ForbiddenException('Only project admins can do this');
    const { members: _m, ...rest } = project;
    return { project: rest as Project, isMember: !!membership, isAdmin };
  }
}
