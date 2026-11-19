import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, Inject, NotFoundException, Param, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { type Db, schema, withTenant } from "@hotel-os/db";
import { and, eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { z } from "zod";
import { AccessService } from "../auth/access.service";
import { AdminGuard } from "../auth/admin.guard";
import { CurrentPrincipal, type Principal } from "../auth/principal";
import { DB } from "../common/db.module";
import { parse, uuidParam } from "../common/validation";
import type { DevicePrincipal } from "../devices/device-auth.service";
import { CurrentDevice, DeviceGuard } from "../devices/device.guard";
import { PolicyService } from "../policy/policy.service";
import { CatalogService } from "./catalog.service";
import { type RolloutScope, RolloutsService } from "./rollouts.service";
import { StorageService } from "./storage.service";

export const ALL_HOTELS_CONFIRMATION = "DEPLOY TO ALL HOTELS";

const CreateRollout = z.object({
  appVersionId: z.string().uuid(),
  scopeType: z.enum(["ALL_HOTELS", "ORG", "HOTEL", "GROUP", "ROOM", "DEVICE"]),
  scopeId: z.string().uuid().nullable().default(null),
  rings: z.array(z.number().int()).min(1).max(10).default([5, 25, 100]),
  failureThresholdPct: z.number().int().min(0).max(100).default(10),
  autoAdvance: z.boolean().default(false),
  updateWindow: z.enum(["IMMEDIATE", "MAINTENANCE"]).default("MAINTENANCE"),
  /** Must equal "DEPLOY TO ALL HOTELS" for scopeType ALL_HOTELS. */
  confirm: z.string().optional(),
});

@Controller()
export class CatalogController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
    private readonly catalog: CatalogService,
    private readonly rollouts: RolloutsService,
    private readonly storage: StorageService,
    private readonly policy: PolicyService,
  ) {}

  /** Org catalog (orgId) or platform catalog (no orgId, platform admins only). Body = raw APK bytes. */
  private resolveCatalog(p: Principal, orgId: string | undefined) {
    if (!orgId) {
      if (!p.isPlatformAdmin) throw new ForbiddenException({ code: "PLATFORM_CATALOG_ADMIN_ONLY" });
      return null;
    }
    uuidParam(orgId, "orgId");
    if (!this.access.can(p, "app:write", orgId, null)) throw new ForbiddenException({ code: "FORBIDDEN", permission: "app:write" });
    return orgId;
  }

  @Post("v1/catalog/apks")
  @UseGuards(AdminGuard)
  async upload(@CurrentPrincipal() p: Principal, @Req() req: Request, @Query("orgId") orgIdQ: string | undefined, @Headers("x-distribution-rights") rights: string | undefined) {
    const orgId = this.resolveCatalog(p, orgIdQ);
    if (rights !== "attested") {
      throw new BadRequestException({ code: "DISTRIBUTION_RIGHTS_ATTESTATION_REQUIRED", message: 'send header "X-Distribution-Rights: attested" to declare you may distribute this APK' });
    }
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new BadRequestException({ code: "EMPTY_BODY", message: "send the APK bytes as the request body (application/vnd.android.package-archive)" });
    return this.catalog.upload(this.access.ctxFor(p), orgId, req.body, p.userId, p.ip);
  }

  @Get("v1/catalog/apps")
  @UseGuards(AdminGuard)
  async list(@CurrentPrincipal() p: Principal, @Query("orgId") orgId: string | undefined) {
    if (orgId) this.access.requireOrg(p, "app:read", uuidParam(orgId, "orgId"));
    else if (!p.isPlatformAdmin) throw new ForbiddenException({ code: "PLATFORM_CATALOG_ADMIN_ONLY" });
    return this.catalog.list(this.access.ctxFor(p), orgId ?? null);
  }

  @Post("v1/rollouts")
  @UseGuards(AdminGuard)
  async create(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    const b = parse(CreateRollout, body);
    let orgId: string | null;
    if (b.scopeType === "ALL_HOTELS") {
      if (!p.isPlatformAdmin) throw new ForbiddenException({ code: "PLATFORM_ONLY" });
      if (b.confirm !== ALL_HOTELS_CONFIRMATION) throw new BadRequestException({ code: "CONFIRMATION_REQUIRED", message: `type "${ALL_HOTELS_CONFIRMATION}" to confirm` });
      orgId = null;
    } else {
      if (!b.scopeId) throw new BadRequestException({ code: "SCOPE_ID_REQUIRED" });
      orgId = await this.authorizeScope(p, b.scopeType, b.scopeId);
    }
    return this.rollouts.create(this.access.ctxFor(p), { ...b, orgId, scopeType: b.scopeType as RolloutScope }, p.userId);
  }

  private async authorizeScope(p: Principal, scopeType: string, scopeId: string): Promise<string> {
    if (scopeType === "ORG") {
      if (!this.access.can(p, "app:write", scopeId, null)) throw new ForbiddenException({ code: "FORBIDDEN", permission: "app:write" });
      return scopeId;
    }
    if (scopeType === "HOTEL") return (await this.access.requireHotel(p, "app:write", scopeId)).orgId;
    if (scopeType === "ROOM") return (await this.access.requireRoom(p, "app:write", scopeId)).orgId;
    if (scopeType === "DEVICE") return (await this.access.requireDevice(p, "app:write", scopeId)).orgId;
    const [g] = await withTenant(this.db, this.access.ctxFor(p), (tx) => tx.select().from(schema.roomGroups).where(eq(schema.roomGroups.id, scopeId)));
    if (!g) throw new NotFoundException({ code: "GROUP_NOT_FOUND" });
    if (!this.access.can(p, "app:write", g.organizationId, g.hotelId)) throw new ForbiddenException({ code: "FORBIDDEN", permission: "app:write" });
    return g.organizationId;
  }

  private async authorizeRollout(p: Principal, id: string, perm: "app:read" | "app:write") {
    const r = await this.rollouts.get(this.access.ctxFor(p), uuidParam(id));
    if (r.organizationId === null) {
      if (!p.isPlatformAdmin) throw new NotFoundException({ code: "ROLLOUT_NOT_FOUND" });
    } else if (r.scopeType === "ORG") {
      if (!this.access.can(p, perm, r.organizationId, null)) throw new ForbiddenException({ code: "FORBIDDEN", permission: perm });
    } else {
      await this.authorizeScope(p, r.scopeType, r.scopeId!).catch((e) => {
        if (perm === "app:read" && this.access.can(p, "app:read", r.organizationId!, null)) return;
        throw e;
      });
    }
    return r;
  }

  @Get("v1/rollouts")
  @UseGuards(AdminGuard)
  async listRollouts(@CurrentPrincipal() p: Principal, @Query("orgId") orgId: string | undefined) {
    if (orgId) this.access.requireOrg(p, "app:read", uuidParam(orgId, "orgId"));
    else if (!p.isPlatformAdmin) throw new ForbiddenException({ code: "PLATFORM_ONLY" });
    return this.rollouts.list(this.access.ctxFor(p), orgId ?? null);
  }

  @Get("v1/rollouts/:id")
  @UseGuards(AdminGuard)
  get(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.authorizeRollout(p, id, "app:read");
  }

  @Post("v1/rollouts/:id/:action")
  @UseGuards(AdminGuard)
  @HttpCode(200)
  async action(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Param("action") action: string) {
    await this.authorizeRollout(p, id, "app:write");
    const ctx = this.access.ctxFor(p);
    switch (action) {
      case "advance":
        return this.rollouts.advance(ctx, id, p.userId);
      case "pause":
        return this.rollouts.setStatus(ctx, id, "PAUSED", p.userId, "paused by an administrator");
      case "resume":
        return this.rollouts.setStatus(ctx, id, "RUNNING", p.userId);
      case "cancel":
        return this.rollouts.setStatus(ctx, id, "CANCELLED", p.userId, "cancelled by an administrator");
      default:
        throw new NotFoundException({ code: "UNKNOWN_ACTION" });
    }
  }

  /** APK download for devices: only files present in the device's CURRENT signed policy. Supports HTTP Range (resume). */
  @Get("device/v1/apk/:sha256")
  @UseGuards(DeviceGuard)
  async download(@CurrentDevice() d: DevicePrincipal, @Param("sha256") sha: string, @Res() res: Response) {
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new BadRequestException({ code: "INVALID_SHA256" });
    const latest = await this.policy.latestDecoded({ orgIds: [d.orgId] }, d.deviceId);
    if (!latest?.policy.apps.some((a) => a.artifact?.sha256 === sha)) throw new NotFoundException({ code: "APK_NOT_IN_DEVICE_POLICY" });
    const [v] = await withTenant(this.db, { orgIds: [], platform: true }, (tx) => tx.select().from(schema.appVersions).where(and(eq(schema.appVersions.sha256, sha))).limit(1));
    if (!v) throw new NotFoundException({ code: "APK_NOT_FOUND" });
    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    res.setHeader("Cache-Control", "private, max-age=0");
    // Path resolved relative to the storage root: the dotfile guard applies to the key only (root may be ".storage").
    res.sendFile(v.objectKey, { root: this.storage.root, acceptRanges: true, dotfiles: "deny" });
  }
}
