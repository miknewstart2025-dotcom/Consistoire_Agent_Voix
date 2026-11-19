import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const ts = (name: string) => timestamp(name, { withTimezone: true });
const created = () => ts("created_at").notNull().defaultNow();
const updated = () => ts("updated_at").notNull().defaultNow();
/** Every tenant-scoped row carries organization_id; RLS policies are keyed on it (see migrations/*_rls.sql). */
const orgId = () => uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" });

export const roleEnum = pgEnum("role", [
  "PLATFORM_ADMIN",
  "PARTNER_ADMIN",
  "ORG_ADMIN",
  "HOTEL_ADMIN",
  "MANAGER",
  "TECHNICIAN",
  "READ_ONLY",
]);
export const scopeTypeEnum = pgEnum("scope_type", ["GLOBAL", "ORG", "HOTEL", "GROUP", "ROOM", "DEVICE"]);
export const commandStatusEnum = pgEnum("command_status", [
  "QUEUED", "DELIVERED", "ACKED", "RUNNING", "SUCCEEDED", "FAILED", "EXPIRED", "CANCELLED",
]);
export const certificationEnum = pgEnum("certification_status", ["CERTIFIED", "PARTIAL", "INCOMPATIBLE", "PENDING"]);
export const stayStatusEnum = pgEnum("stay_status", ["ACTIVE", "CHECKED_OUT", "CANCELLED"]);
export const cleanupStatusEnum = pgEnum("cleanup_status", ["PENDING", "RUNNING", "SUCCEEDED", "PARTIAL", "FAILED"]);
export const appSourceEnum = pgEnum("app_source", ["NATIVE", "CATALOG", "FIRST_PARTY"]);

// ---------------------------------------------------------------- tenancy
export const partners = pgTable("partners", {
  id: id(),
  name: text("name").notNull(),
  createdAt: created(),
});

export const organizations = pgTable("organizations", {
  id: id(),
  partnerId: uuid("partner_id").references(() => partners.id),
  name: text("name").notNull(),
  createdAt: created(),
  updatedAt: updated(),
});

export const subscriptions = pgTable("subscriptions", {
  id: id(),
  organizationId: orgId(),
  plan: text("plan").notNull(),
  modules: text("modules").array().notNull().default(sql`'{}'::text[]`),
  maxRooms: integer("max_rooms"),
  status: text("status").notNull().default("ACTIVE"),
  createdAt: created(),
});

export const hotels = pgTable(
  "hotels",
  {
    id: id(),
    organizationId: orgId(),
    name: text("name").notNull(),
    address: text("address"),
    timezone: text("timezone").notNull().default("Europe/Paris"),
    defaultLanguage: text("default_language").notNull().default("fr"),
    languages: text("languages").array().notNull().default(sql`'{fr,en}'::text[]`),
    contact: jsonb("contact").notNull().default({}),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index("hotels_org_idx").on(t.organizationId)],
);

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  totpSecret: text("totp_secret"),
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
  failedLogins: integer("failed_logins").notNull().default(0),
  lockedUntil: ts("locked_until"),
  createdAt: created(),
});

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    organizationId: orgId(),
    /** null = whole organization */
    hotelId: uuid("hotel_id").references(() => hotels.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull(),
    createdAt: created(),
  },
  (t) => [index("memberships_user_idx").on(t.userId)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    organizationId: uuid("organization_id"),
    actorType: text("actor_type").notNull(), // USER | DEVICE | SYSTEM
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    data: jsonb("data").notNull().default({}),
    ip: text("ip"),
    createdAt: created(),
  },
  (t) => [index("audit_org_created_idx").on(t.organizationId, t.createdAt)],
);

// ---------------------------------------------------------------- topology
export const roomGroups = pgTable(
  "room_groups",
  {
    id: id(),
    organizationId: orgId(),
    hotelId: uuid("hotel_id").notNull().references(() => hotels.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    priority: integer("priority").notNull().default(0),
    createdAt: created(),
  },
  (t) => [uniqueIndex("room_groups_hotel_name_uq").on(t.hotelId, t.name)],
);

export const rooms = pgTable(
  "rooms",
  {
    id: id(),
    organizationId: orgId(),
    hotelId: uuid("hotel_id").notNull().references(() => hotels.id, { onDelete: "cascade" }),
    number: text("number").notNull(),
    floor: text("floor"),
    roomType: text("room_type"),
    status: text("status").notNull().default("ACTIVE"),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("rooms_hotel_number_uq").on(t.hotelId, t.number)],
);

export const roomGroupMembers = pgTable(
  "room_group_members",
  {
    organizationId: orgId(),
    roomId: uuid("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
    groupId: uuid("group_id").notNull().references(() => roomGroups.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.groupId] })],
);

// ---------------------------------------------------------------- hardware
export const deviceModels = pgTable(
  "device_models",
  {
    id: id(),
    manufacturer: text("manufacturer").notNull(),
    model: text("model").notNull(),
    androidVersion: text("android_version"),
    apiLevel: integer("api_level"),
    specs: jsonb("specs").notNull().default({}),
    status: certificationEnum("status").notNull().default("PENDING"),
    /** ModelCapabilities consumed by the policy engine. */
    capabilities: jsonb("capabilities").notNull().default({ lockTaskSupported: false, persistentHomeSupported: false }),
    notes: text("notes"),
    createdAt: created(),
  },
  (t) => [uniqueIndex("device_models_uq").on(t.manufacturer, t.model)],
);

export const certificationReports = pgTable("certification_reports", {
  id: id(),
  deviceModelId: uuid("device_model_id").notNull().references(() => deviceModels.id, { onDelete: "cascade" }),
  buildFingerprint: text("build_fingerprint"),
  report: jsonb("report").notNull(),
  verdict: certificationEnum("verdict").notNull().default("PENDING"),
  submittedBy: text("submitted_by"),
  createdAt: created(),
});

export const devices = pgTable(
  "devices",
  {
    id: id(),
    organizationId: orgId(),
    hotelId: uuid("hotel_id").notNull().references(() => hotels.id, { onDelete: "cascade" }),
    roomId: uuid("room_id").references(() => rooms.id, { onDelete: "set null" }),
    deviceModelId: uuid("device_model_id").references(() => deviceModels.id),
    status: text("status").notNull().default("ENROLLED"), // ENROLLED | ACTIVE | REVOKED | REPLACED
    hardware: jsonb("hardware").notNull().default({}),
    isDeviceOwner: boolean("is_device_owner").notNull().default(false),
    kioskActive: boolean("kiosk_active").notNull().default(false),
    launcherHealthy: boolean("launcher_healthy").notNull().default(false),
    versions: jsonb("versions").notNull().default({}),
    telemetry: jsonb("telemetry").notNull().default({}),
    policyVersionApplied: integer("policy_version_applied").notNull().default(0),
    reconcileErrors: jsonb("reconcile_errors").notNull().default([]),
    pairingCode: text("pairing_code"),
    pairingExpiresAt: ts("pairing_expires_at"),
    lastSeenAt: ts("last_seen_at"),
    lastStateAt: ts("last_state_at"),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index("devices_hotel_idx").on(t.hotelId),
    uniqueIndex("devices_pairing_code_uq").on(t.pairingCode),
    // At most one active device per room.
    uniqueIndex("devices_one_active_per_room_uq").on(t.roomId).where(sql`status in ('ENROLLED','ACTIVE') and room_id is not null`),
  ],
);

export const deviceRoomHistory = pgTable("device_room_history", {
  id: id(),
  organizationId: orgId(),
  deviceId: uuid("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
  roomId: uuid("room_id").references(() => rooms.id, { onDelete: "set null" }),
  event: text("event").notNull(), // PAIRED | UNPAIRED | REPLACED
  actorId: text("actor_id"),
  createdAt: created(),
});

export const deviceCredentials = pgTable("device_credentials", {
  id: id(),
  organizationId: orgId(),
  deviceId: uuid("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
  publicKeySpki: text("public_key_spki").notNull(),
  fingerprint: text("fingerprint").notNull(),
  attestation: jsonb("attestation"),
  status: text("status").notNull().default("ACTIVE"), // ACTIVE | REVOKED | ROTATED
  createdAt: created(),
  revokedAt: ts("revoked_at"),
});

export const enrollmentTokens = pgTable("enrollment_tokens", {
  id: id(),
  organizationId: orgId(),
  hotelId: uuid("hotel_id").notNull().references(() => hotels.id, { onDelete: "cascade" }),
  /** sha256 of the token; the clear token is shown once. */
  tokenHash: text("token_hash").notNull().unique(),
  maxUses: integer("max_uses").notNull().default(1),
  uses: integer("uses").notNull().default(0),
  expiresAt: ts("expires_at").notNull(),
  createdBy: uuid("created_by"),
  createdAt: created(),
});

// ---------------------------------------------------------------- configuration & policy
export const configLayers = pgTable(
  "config_layers",
  {
    id: id(),
    /** null only for GLOBAL scope (platform-owned) */
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    scopeType: scopeTypeEnum("scope_type").notNull(),
    scopeId: text("scope_id").notNull(),
    values: jsonb("values").notNull().default({}),
    lockedKeys: text("locked_keys").array().notNull().default(sql`'{}'::text[]`),
    version: integer("version").notNull().default(1),
    updatedBy: uuid("updated_by"),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("config_layers_scope_uq").on(t.scopeType, t.scopeId)],
);

export const configLayerHistory = pgTable("config_layer_history", {
  id: id(),
  organizationId: uuid("organization_id"),
  layerId: uuid("layer_id").notNull(),
  version: integer("version").notNull(),
  values: jsonb("values").notNull(),
  lockedKeys: text("locked_keys").array().notNull(),
  updatedBy: uuid("updated_by"),
  createdAt: created(),
});

export const effectivePolicies = pgTable(
  "effective_policies",
  {
    id: id(),
    organizationId: orgId(),
    deviceId: uuid("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    hash: text("hash").notNull(),
    signed: jsonb("signed").notNull(),
    explain: jsonb("explain").notNull().default({}),
    warnings: text("warnings").array().notNull().default(sql`'{}'::text[]`),
    createdAt: created(),
  },
  (t) => [uniqueIndex("effective_policies_device_version_uq").on(t.deviceId, t.version)],
);

// ---------------------------------------------------------------- applications
export const apps = pgTable(
  "apps",
  {
    id: id(),
    /** null = platform catalog (visible to all orgs) */
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    packageName: text("package_name").notNull(),
    name: text("name").notNull(),
    source: appSourceEnum("source").notNull(),
    category: text("category"),
    description: text("description"),
    iconUrl: text("icon_url"),
    /** Pinned signing certificate (sha256 hex). Every version must match. */
    signerSha256: text("signer_sha256"),
    createdAt: created(),
  },
  (t) => [uniqueIndex("apps_org_pkg_uq").on(t.organizationId, t.packageName)],
);

export const appVersions = pgTable(
  "app_versions",
  {
    id: id(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    appId: uuid("app_id").notNull().references(() => apps.id, { onDelete: "cascade" }),
    versionCode: bigint("version_code", { mode: "number" }).notNull(),
    versionName: text("version_name").notNull(),
    objectKey: text("object_key").notNull(),
    sha256: text("sha256").notNull(),
    signerSha256: text("signer_sha256").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    minSdk: integer("min_sdk"),
    targetSdk: integer("target_sdk"),
    abis: text("abis").array().notNull().default(sql`'{}'::text[]`),
    permissions: text("permissions").array().notNull().default(sql`'{}'::text[]`),
    analysis: jsonb("analysis").notNull().default({}),
    distributionRightsAttestedBy: uuid("distribution_rights_attested_by"),
    status: text("status").notNull().default("UPLOADED"), // UPLOADED | VERIFIED | PUBLISHED | REJECTED | WITHDRAWN
    createdAt: created(),
  },
  (t) => [uniqueIndex("app_versions_app_code_uq").on(t.appId, t.versionCode)],
);

export const deviceAppInventory = pgTable(
  "device_app_inventory",
  {
    organizationId: orgId(),
    deviceId: uuid("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
    packageName: text("package_name").notNull(),
    label: text("label"),
    versionCode: bigint("version_code", { mode: "number" }).notNull(),
    versionName: text("version_name"),
    system: boolean("system").notNull(),
    enabled: boolean("enabled").notNull(),
    suspended: boolean("suspended").notNull(),
    hidden: boolean("hidden").notNull(),
    hasLauncherEntry: boolean("has_launcher_entry").notNull(),
    signerSha256: text("signer_sha256"),
    canSuspend: boolean("can_suspend"),
    canHide: boolean("can_hide"),
    observedAt: ts("observed_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.packageName] })],
);

// ---------------------------------------------------------------- commands
export const commands = pgTable(
  "commands",
  {
    id: id(),
    organizationId: orgId(),
    deviceId: uuid("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    idempotencyKey: text("idempotency_key"),
    status: commandStatusEnum("status").notNull().default("QUEUED"),
    resultMessage: text("result_message"),
    resultData: jsonb("result_data"),
    createdBy: text("created_by"),
    createdAt: created(),
    updatedAt: updated(),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [
    index("commands_device_status_idx").on(t.deviceId, t.status),
    uniqueIndex("commands_idem_uq").on(t.deviceId, t.idempotencyKey),
  ],
);

export const commandEvents = pgTable("command_events", {
  id: id(),
  organizationId: orgId(),
  commandId: uuid("command_id").notNull().references(() => commands.id, { onDelete: "cascade" }),
  status: commandStatusEnum("status").notNull(),
  message: text("message"),
  createdAt: created(),
});

// ---------------------------------------------------------------- stays & cleanup
export const stays = pgTable(
  "stays",
  {
    id: id(),
    organizationId: orgId(),
    hotelId: uuid("hotel_id").notNull().references(() => hotels.id, { onDelete: "cascade" }),
    roomId: uuid("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
    status: stayStatusEnum("status").notNull().default("ACTIVE"),
    /** Optional, only displayed with consent. Purged by retention job. */
    guestFirstName: text("guest_first_name"),
    displayNameConsent: boolean("display_name_consent").notNull().default(false),
    language: text("language"),
    source: text("source").notNull().default("MANUAL"),
    pmsRef: text("pms_ref"),
    checkInAt: ts("check_in_at").notNull().defaultNow(),
    checkOutAt: ts("check_out_at"),
    purgedAt: ts("purged_at"),
  },
  (t) => [uniqueIndex("stays_one_active_per_room_uq").on(t.roomId).where(sql`status = 'ACTIVE'`)],
);

export const cleanupJobs = pgTable("cleanup_jobs", {
  id: id(),
  organizationId: orgId(),
  stayId: uuid("stay_id").references(() => stays.id, { onDelete: "set null" }),
  deviceId: uuid("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
  commandId: uuid("command_id").references(() => commands.id),
  status: cleanupStatusEnum("status").notNull().default("PENDING"),
  report: jsonb("report"),
  createdAt: created(),
  finishedAt: ts("finished_at"),
});

// ---------------------------------------------------------------- IPTV
export const iptvSources = pgTable("iptv_sources", {
  id: id(),
  organizationId: orgId(),
  hotelId: uuid("hotel_id").notNull().references(() => hotels.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  playlistUrl: text("playlist_url").notNull(),
  epgUrl: text("epg_url"),
  /** Encrypted at application level (see SecretsService) – never returned by the API. */
  credentialsEnc: text("credentials_enc"),
  /** The hotel attests it holds the broadcasting rights for these streams. */
  rightsAttestedBy: uuid("rights_attested_by").notNull(),
  rightsAttestedAt: ts("rights_attested_at").notNull().defaultNow(),
  lastSyncAt: ts("last_sync_at"),
  lastSyncStatus: text("last_sync_status"),
  lastSyncMessage: text("last_sync_message"),
  createdAt: created(),
});

export const channels = pgTable(
  "channels",
  {
    id: id(),
    organizationId: orgId(),
    hotelId: uuid("hotel_id").notNull().references(() => hotels.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").notNull().references(() => iptvSources.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    name: text("name").notNull(),
    epgId: text("epg_id"),
    logoUrl: text("logo_url"),
    category: text("category"),
    language: text("language"),
    streamUrl: text("stream_url").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("channels_source_stream_uq").on(t.sourceId, t.streamUrl), index("channels_hotel_idx").on(t.hotelId)],
);

export const epgPrograms = pgTable(
  "epg_programs",
  {
    id: id(),
    organizationId: orgId(),
    sourceId: uuid("source_id").notNull().references(() => iptvSources.id, { onDelete: "cascade" }),
    epgId: text("epg_id").notNull(),
    start: ts("start").notNull(),
    stop: ts("stop").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    category: text("category"),
  },
  (t) => [index("epg_source_channel_start_idx").on(t.sourceId, t.epgId, t.start)],
);
