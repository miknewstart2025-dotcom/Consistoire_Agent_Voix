import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { AuthService } from "./auth.service";

/** Requires a valid admin access token (Authorization: Bearer). */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const h: string | undefined = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) throw new UnauthorizedException({ code: "MISSING_TOKEN" });
    req.principal = await this.auth.principalFromToken(h.slice(7));
    req.principal.ip = req.ip;
    return true;
  }
}
