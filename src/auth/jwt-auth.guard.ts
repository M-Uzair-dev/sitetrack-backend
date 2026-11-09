import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AppRole } from '@prisma/client';
import { IS_PUBLIC_KEY, ROLES_KEY } from '../common/auth-user';
import { PrismaService } from '../prisma/prisma.service';

const UUID_RE = /^[0-9a-f-]{36}$/i;

/**
 * Global guard. Verifies the access JWT and then loads the session + user from the
 * database on every request, so that:
 *  - a logged-out (revoked) session stops working immediately, and
 *  - the role used for authorization is always the current one, never a stale JWT claim.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly jwt: JwtService, private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token');

    let payload: { sub: number; sid: string };
    try {
      payload = await this.jwt.verifyAsync(header.slice(7));
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
    if (typeof payload.sid !== 'string' || !UUID_RE.test(payload.sid)) throw new UnauthorizedException('Invalid access token');

    const session = await this.prisma.session.findUnique({
      where: { id: payload.sid },
      select: { id: true, userId: true, revokedAt: true, expiresAt: true, user: { select: { id: true, role: true } } },
    });
    if (!session || session.userId !== payload.sub || session.revokedAt || session.expiresAt < new Date()) {
      throw new UnauthorizedException('Session has ended, please log in again');
    }
    req.user = { id: session.user.id, role: session.user.role, sessionId: session.id };

    const roles = this.reflector.getAllAndOverride<AppRole[] | undefined>(ROLES_KEY, targets);
    if (roles && !roles.includes(session.user.role)) throw new ForbiddenException('Your role does not allow this');
    return true;
  }
}
