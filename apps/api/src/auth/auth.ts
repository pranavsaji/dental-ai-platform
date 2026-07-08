import {
  Body, CanActivate, Controller, ExecutionContext, Get, HttpException, Inject,
  Injectable, Post, Req, UnauthorizedException, UseGuards, createParamDecorator
} from "@nestjs/common";
import type { Request } from "express";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { users, scryptVerify } from "@dental/db";
import { DB, type Db } from "../db";
import { AuditService } from "../audit.service";

const JWT_SECRET = () => process.env.JWT_SECRET ?? "dev-jwt-secret-change-me";

export interface SessionUser {
  sub: number;
  orgId: number;
  email: string;
  name: string;
  role: string; // admin | provider | staff
  locationId: number | null; // null = all locations in org
}

@Injectable()
export class JwtGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new UnauthorizedException("Missing bearer token");
    try {
      req.user = jwt.verify(header.slice(7), JWT_SECRET()) as unknown as SessionUser;
      return true;
    } catch {
      throw new UnauthorizedException("Invalid token");
    }
  }
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SessionUser => ctx.switchToHttp().getRequest().user
);

// Fixed-window brute-force limiter, in-memory (single API instance). A SOC 2
// CC6.1 control: repeated credential guessing is slowed and audit-logged.
const LOGIN_WINDOW_MS = 5 * 60_000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map<string, { count: number; windowStart: number }>();

function loginRateLimited(key: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > LOGIN_MAX_ATTEMPTS;
}

@Controller("auth")
export class AuthController {
  constructor(
    @Inject(DB) private db: Db,
    private audit: AuditService
  ) {}

  @Post("login")
  async login(@Req() req: Request, @Body() body: { email?: string; password?: string }) {
    const email = (body.email ?? "").toLowerCase().trim();
    if (loginRateLimited(`${req.ip}`)) {
      throw new HttpException("Too many login attempts; try again in a few minutes", 429);
    }
    const [user] = await this.db.select().from(users).where(eq(users.email, email));
    // Null passwordHash = SSO-only account: password login always fails.
    if (!user || !user.passwordHash || !scryptVerify(body.password ?? "", user.passwordHash)) {
      if (user) {
        await this.audit.log({
          orgId: user.orgId, actorType: "user", actor: email,
          action: "auth.login.failed", resource: "session"
        });
      }
      throw new UnauthorizedException("Invalid credentials");
    }
    const session: SessionUser = {
      sub: user.id,
      orgId: user.orgId,
      email: user.email,
      name: user.name,
      role: user.role,
      locationId: user.locationId
    };
    await this.audit.log({
      orgId: user.orgId, actorType: "user", actor: user.email,
      action: "auth.login", resource: "session"
    });
    return {
      token: jwt.sign(session, JWT_SECRET(), { expiresIn: "12h" }),
      user: session
    };
  }

  @Get("me")
  @UseGuards(JwtGuard)
  me(@CurrentUser() user: SessionUser) {
    return user;
  }
}
