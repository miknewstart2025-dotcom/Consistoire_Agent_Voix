import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { type Db, schema, type TenantContext, withTenant } from "@hotel-os/db";
import { eq } from "drizzle-orm";
import { DB } from "../common/db.module";
import type { Principal } from "./principal";
import { type Permission, ROLE_PERMISSIONS } from "./rbac";

export interface HotelScope {
  orgId: string;
  hotelId: string;
  ctx: TenantContext;
}

/**
 * Application-level authorization (first barrier). Postgres RLS is the second barrier:
 * the TenantContext only ever contains orgs the principal is a member of.
 */
@Injectable()
export class AccessService {
  constructor(@Inject(DB) private readonly db: Db) {}

  ctxFor(p: Principal): TenantContext {
    return { orgIds: [...new Set(p.memberships.map((m) => m.orgId))], platform: p.isPlatformAdmin };
  }

  can(p: Principal, perm: Permission, orgId: string, hotelId: string | null): boolean {
    if (p.isPlatformAdmin) return true;
    return p.memberships.some(
      (m) => m.orgId === orgId && (m.hotelId === null || m.hotelId === hotelId) && ROLE_PERMISSIONS[m.role].has(perm),
    );
  }

  /** Hotel ids (within org) the principal can access with `perm`; null = all hotels of that org. */
  hotelFilter(p: Principal, perm: Permission, orgId: string): string[] | null {
    if (p.isPlatformAdmin) return null;
    const ms = p.memberships.filter((m) => m.orgId === orgId && ROLE_PERMISSIONS[m.role].has(perm));
    if (ms.some((m) => m.hotelId === null)) return null;
    return ms.map((m) => m.hotelId!);
  }

  requireOrg(p: Principal, perm: Permission, orgId: string): TenantContext {
    if (!this.can(p, perm, orgId, null) && !(this.hotelFilter(p, perm, orgId)?.length)) {
      throw new ForbiddenException({ code: "FORBIDDEN", permission: perm });
    }
    return this.ctxFor(p);
  }

  /** Loads the hotel through RLS (so a foreign hotel is simply "not found") and checks the permission. */
  async requireHotel(p: Principal, perm: Permission, hotelId: string): Promise<HotelScope> {
    const ctx = this.ctxFor(p);
    const hotel = await withTenant(this.db, ctx, async (tx) => {
      const [h] = await tx.select({ id: schema.hotels.id, orgId: schema.hotels.organizationId }).from(schema.hotels).where(eq(schema.hotels.id, hotelId));
      return h;
    });
    if (!hotel) throw new NotFoundException({ code: "HOTEL_NOT_FOUND" });
    if (!this.can(p, perm, hotel.orgId, hotel.id)) throw new ForbiddenException({ code: "FORBIDDEN", permission: perm });
    return { orgId: hotel.orgId, hotelId: hotel.id, ctx };
  }

  async requireDevice(p: Principal, perm: Permission, deviceId: string) {
    const ctx = this.ctxFor(p);
    const d = await withTenant(this.db, ctx, async (tx) => {
      const [x] = await tx
        .select({ id: schema.devices.id, orgId: schema.devices.organizationId, hotelId: schema.devices.hotelId, roomId: schema.devices.roomId })
        .from(schema.devices)
        .where(eq(schema.devices.id, deviceId));
      return x;
    });
    if (!d) throw new NotFoundException({ code: "DEVICE_NOT_FOUND" });
    if (!this.can(p, perm, d.orgId, d.hotelId)) throw new ForbiddenException({ code: "FORBIDDEN", permission: perm });
    return { ...d, ctx };
  }

  async requireRoom(p: Principal, perm: Permission, roomId: string) {
    const ctx = this.ctxFor(p);
    const r = await withTenant(this.db, ctx, async (tx) => {
      const [x] = await tx
        .select({ id: schema.rooms.id, orgId: schema.rooms.organizationId, hotelId: schema.rooms.hotelId, number: schema.rooms.number })
        .from(schema.rooms)
        .where(eq(schema.rooms.id, roomId));
      return x;
    });
    if (!r) throw new NotFoundException({ code: "ROOM_NOT_FOUND" });
    if (!this.can(p, perm, r.orgId, r.hotelId)) throw new ForbiddenException({ code: "FORBIDDEN", permission: perm });
    return { ...r, ctx };
  }
}
