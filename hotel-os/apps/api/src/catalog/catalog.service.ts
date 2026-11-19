import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { type Db, schema, type TenantContext, withTenant } from "@hotel-os/db";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { AuditService } from "../common/audit.service";
import { DB } from "../common/db.module";
import { analyzeApk, type ApkAnalysis } from "./apk-analyzer";
import { StorageService } from "./storage.service";

export const FIRST_PARTY = new Set(["com.hotelos.dpc", "com.hotelos.launcher", "com.hotelos.iptv"]);
/**
 * Commercial apps must come from their official store, never re-hosted (licensing + DRM).
 * Uploading them is refused even with an attestation.
 */
export const STORE_ONLY = [/^com\.netflix\./, /^com\.google\.android\.youtube/, /^com\.amazon\.(amazonvideo|avod)/, /^com\.disney\./, /^com\.spotify\./, /^com\.hbo\./, /^com\.apple\.atve/, /^com\.google\.android\.(gms|vending)$/];

@Injectable()
export class CatalogService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Analyses, checks and stores an uploaded APK. `orgId = null` → platform catalog.
   * The file is stored byte-for-byte: HOTEL OS never re-packages or re-signs third-party apps.
   */
  async upload(ctx: TenantContext, orgId: string | null, file: Buffer, userId: string, ip?: string) {
    let a: ApkAnalysis;
    try {
      a = analyzeApk(file);
    } catch (e) {
      throw new BadRequestException({ code: "APK_REJECTED", message: (e as Error).message });
    }
    if (STORE_ONLY.some((r) => r.test(a.packageName))) {
      throw new ForbiddenException({ code: "STORE_ONLY_APP", message: `${a.packageName} must be installed from its official store, never uploaded` });
    }
    if (FIRST_PARTY.has(a.packageName) && orgId !== null) throw new ForbiddenException({ code: "FIRST_PARTY_PLATFORM_ONLY" });
    const key = `apk/${a.sha256}.apk`;
    const row = await withTenant(this.db, ctx, async (tx) => {
      // A package lives in exactly one catalog: platform OR one organization (no shadowing of platform apps).
      const existing = await tx
        .select()
        .from(schema.apps)
        .where(and(eq(schema.apps.packageName, a.packageName), orgId ? or(isNull(schema.apps.organizationId), eq(schema.apps.organizationId, orgId)) : isNull(schema.apps.organizationId)));
      const other = existing.find((x) => x.organizationId !== orgId);
      if (other) throw new ConflictException({ code: "PACKAGE_OWNED_BY_PLATFORM_CATALOG", message: `${a.packageName} is managed in the platform catalog` });
      let app = existing.find((x) => x.organizationId === orgId);
      if (app && app.signerSha256 !== a.signerSha256) {
        // Android itself refuses an update signed with another key; refuse early with a clear message.
        throw new ConflictException({ code: "SIGNER_MISMATCH", message: `signing certificate ${a.signerSha256.slice(0, 16)}… differs from the pinned ${app.signerSha256?.slice(0, 16)}…` });
      }
      if (!app) {
        [app] = await tx
          .insert(schema.apps)
          .values({ organizationId: orgId, packageName: a.packageName, name: a.label && !a.label.startsWith("@") ? a.label : a.packageName, source: FIRST_PARTY.has(a.packageName) ? "FIRST_PARTY" : "CATALOG", signerSha256: a.signerSha256 })
          .returning();
      }
      const [dup] = await tx.select().from(schema.appVersions).where(and(eq(schema.appVersions.appId, app.id), eq(schema.appVersions.versionCode, a.versionCode)));
      if (dup) throw new ConflictException({ code: "VERSION_EXISTS", message: `versionCode ${a.versionCode} already uploaded (bump versionCode; rollback = roll-forward)` });
      const [v] = await tx
        .insert(schema.appVersions)
        .values({
          organizationId: orgId,
          appId: app.id,
          versionCode: a.versionCode,
          versionName: a.versionName,
          objectKey: key,
          sha256: a.sha256,
          signerSha256: a.signerSha256,
          sizeBytes: a.sizeBytes,
          minSdk: a.minSdk,
          targetSdk: a.targetSdk,
          abis: a.abis,
          permissions: a.permissions,
          analysis: a,
          distributionRightsAttestedBy: userId,
          status: "VERIFIED",
        })
        .returning();
      await this.audit.log(tx, { organizationId: orgId, actorType: "USER", actorId: userId, action: "catalog.upload", targetType: "APP_VERSION", targetId: v.id, data: { packageName: a.packageName, versionCode: a.versionCode, sha256: a.sha256, signer: a.signerSha256, warnings: a.warnings, distributionRightsAttested: true }, ip });
      return { app, version: v };
    });
    if (!(await this.storage.exists(key))) await this.storage.put(key, file);
    return { appId: row.app.id, versionId: row.version.id, analysis: a };
  }

  async list(ctx: TenantContext, orgId: string | null) {
    return withTenant(this.db, ctx, async (tx) => {
      const apps = await tx
        .select()
        .from(schema.apps)
        .where(orgId ? or(isNull(schema.apps.organizationId), eq(schema.apps.organizationId, orgId)) : isNull(schema.apps.organizationId));
      const out = [];
      for (const app of apps) {
        if (app.source === "NATIVE") continue;
        const versions = await tx
          .select({ id: schema.appVersions.id, versionCode: schema.appVersions.versionCode, versionName: schema.appVersions.versionName, status: schema.appVersions.status, sizeBytes: schema.appVersions.sizeBytes, minSdk: schema.appVersions.minSdk, abis: schema.appVersions.abis, analysis: schema.appVersions.analysis, createdAt: schema.appVersions.createdAt })
          .from(schema.appVersions)
          .where(eq(schema.appVersions.appId, app.id))
          .orderBy(desc(schema.appVersions.versionCode));
        out.push({ ...app, scope: app.organizationId ? "ORG" : "PLATFORM", versions: versions.map((v) => ({ ...v, warnings: (v.analysis as ApkAnalysis).warnings, analysis: undefined })) });
      }
      return out;
    });
  }
}
