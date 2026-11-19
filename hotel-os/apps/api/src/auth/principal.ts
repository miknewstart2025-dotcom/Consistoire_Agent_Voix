import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Role } from "./rbac";

export interface MembershipClaim {
  orgId: string;
  hotelId: string | null;
  role: Role;
}
export interface Principal {
  userId: string;
  email: string;
  isPlatformAdmin: boolean;
  memberships: MembershipClaim[];
  ip?: string;
}

export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  return ctx.switchToHttp().getRequest().principal;
});
