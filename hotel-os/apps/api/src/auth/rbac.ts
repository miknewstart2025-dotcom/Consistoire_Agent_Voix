export const PERMISSIONS = [
  "org:read",
  "org:manage",
  "hotel:read",
  "hotel:write",
  "room:read",
  "room:write",
  "device:read",
  "device:pair",
  "device:revoke",
  "enroll:create",
  "config:read",
  "config:write",
  "command:send",
  "command:send_basic",
  "stay:read",
  "stay:write",
  "app:read",
  "app:write",
  "audit:read",
  "user:manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export type Role =
  | "PLATFORM_ADMIN"
  | "PARTNER_ADMIN"
  | "ORG_ADMIN"
  | "HOTEL_ADMIN"
  | "MANAGER"
  | "TECHNICIAN"
  | "READ_ONLY";

const READ: Permission[] = ["org:read", "hotel:read", "room:read", "device:read", "config:read", "stay:read", "app:read"];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  PLATFORM_ADMIN: new Set(PERMISSIONS),
  PARTNER_ADMIN: new Set(PERMISSIONS),
  ORG_ADMIN: new Set(PERMISSIONS),
  HOTEL_ADMIN: new Set<Permission>([
    ...READ,
    "hotel:write",
    "room:write",
    "device:pair",
    "device:revoke",
    "enroll:create",
    "config:write",
    "command:send",
    "command:send_basic",
    "stay:write",
    "app:write",
    "audit:read",
    "user:manage",
  ]),
  MANAGER: new Set<Permission>([...READ, "stay:write", "command:send_basic"]),
  /** Technicians manage hardware but never see guest data (no stay:read). */
  TECHNICIAN: new Set<Permission>([
    "org:read",
    "hotel:read",
    "room:read",
    "device:read",
    "device:pair",
    "enroll:create",
    "config:read",
    "app:read",
    "command:send",
    "command:send_basic",
  ]),
  READ_ONLY: new Set<Permission>(READ),
};

/** Commands a MANAGER (command:send_basic) may send. Others need command:send. */
export const BASIC_COMMANDS = new Set(["SHOW_MESSAGE", "REFRESH_UI", "SYNC_NOW", "LAUNCH_APP"]);
