import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, User } from '@prisma/client';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto, RegisterDto } from './auth.dto';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export const publicUser = (u: Pick<User, 'id' | 'name' | 'email' | 'role' | 'createdAt'>) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  createdAt: u.createdAt,
});

@Injectable()
export class AuthService {
  private readonly accessTtl: number;
  private readonly refreshTtlMs: number;
  /** Used so that a login for an unknown email costs the same time as a wrong password. */
  private readonly dummyHash: Promise<string>;

  constructor(private readonly prisma: PrismaService, private readonly jwt: JwtService, config: ConfigService) {
    this.accessTtl = Number(config.get('ACCESS_TOKEN_TTL_SECONDS') ?? 900);
    this.refreshTtlMs = Number(config.get('REFRESH_TOKEN_TTL_DAYS') ?? 30) * 86_400_000;
    this.dummyHash = argon2.hash('timing-equaliser-' + randomBytes(8).toString('hex'));
  }

  async register(dto: RegisterDto) {
    const passwordHash = await argon2.hash(dto.password);
    let user: User;
    try {
      user = await this.prisma.user.create({ data: { name: dto.name, email: dto.email, passwordHash, role: dto.role } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('An account with this email already exists');
      }
      throw e;
    }
    return { user: publicUser(user), ...(await this.createSession(user.id)) };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    // Always run a verification so response time does not reveal whether the email exists.
    const ok = await argon2.verify(user?.passwordHash ?? (await this.dummyHash), dto.password).catch(() => false);
    if (!user || !ok) throw new UnauthorizedException('Invalid email or password');
    return { user: publicUser(user), ...(await this.createSession(user.id)) };
  }

  /** Rotates the refresh token. Re-use of an already-rotated token revokes the whole session. */
  async refresh(refreshToken: string) {
    const hash = sha256(refreshToken);
    const session = await this.prisma.session.findUnique({ where: { refreshTokenHash: hash } });
    if (!session) {
      const reused = await this.prisma.session.findFirst({ where: { previousTokenHash: hash, revokedAt: null } });
      if (reused) await this.prisma.session.update({ where: { id: reused.id }, data: { revokedAt: new Date() } });
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (session.revokedAt || session.expiresAt < new Date()) throw new UnauthorizedException('Session has ended, please log in again');

    const next = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.refreshTtlMs);
    const { count } = await this.prisma.session.updateMany({
      where: { id: session.id, refreshTokenHash: hash, revokedAt: null },
      data: { refreshTokenHash: sha256(next), previousTokenHash: hash, expiresAt, lastUsedAt: new Date() },
    });
    if (count === 0) throw new UnauthorizedException('Invalid refresh token');
    return this.tokens(session.userId, session.id, next, expiresAt);
  }

  async logout(sessionId: string) {
    await this.prisma.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async me(userId: number) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return publicUser(user);
  }

  private async createSession(userId: number) {
    const refreshToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.refreshTtlMs);
    const session = await this.prisma.session.create({
      data: { userId, refreshTokenHash: sha256(refreshToken), expiresAt },
    });
    return this.tokens(userId, session.id, refreshToken, expiresAt);
  }

  private tokens(userId: number, sessionId: string, refreshToken: string, refreshExpiresAt: Date) {
    const accessToken = this.jwt.sign({ sub: userId, sid: sessionId }, { expiresIn: this.accessTtl });
    return { accessToken, accessTokenExpiresIn: this.accessTtl, refreshToken, refreshTokenExpiresAt: refreshExpiresAt };
  }
}
