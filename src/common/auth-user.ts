import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { AppRole } from '@prisma/client';

/** The authenticated caller, loaded fresh from the database on every request. */
export interface AuthUser {
  id: number;
  role: AppRole;
  sessionId: string;
}

export const IS_PUBLIC_KEY = 'isPublic';
/** Marks a route as reachable without an access token. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLES_KEY = 'roles';
/** Restricts a route to the given app roles (checked against the DB role on every request). */
export const Roles = (...roles: AppRole[]) => SetMetadata(ROLES_KEY, roles);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});

export const isStoreRole = (role: AppRole) => role === 'COMPANY_STORE_MANAGER' || role === 'SUPER_ADMIN';
