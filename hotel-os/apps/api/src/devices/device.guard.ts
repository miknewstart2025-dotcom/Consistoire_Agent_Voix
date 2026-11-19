import { type CanActivate, createParamDecorator, type ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { DeviceAuthService, type DevicePrincipal } from "./device-auth.service";

@Injectable()
export class DeviceGuard implements CanActivate {
  constructor(private readonly auth: DeviceAuthService) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const h: string | undefined = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) throw new UnauthorizedException({ code: "MISSING_TOKEN" });
    req.device = await this.auth.authenticate(h.slice(7));
    return true;
  }
}

export const CurrentDevice = createParamDecorator((_: unknown, ctx: ExecutionContext): DevicePrincipal => ctx.switchToHttp().getRequest().device);
