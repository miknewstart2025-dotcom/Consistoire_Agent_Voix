import { APP_STATE_RESTRICTIVENESS, type AppDesiredState, SCOPE_ORDER } from "@hotel-os/protocol";
import type { ConfigLayer } from "./config";

export interface Origin {
  scopeType: ConfigLayer["scopeType"];
  scopeId: string;
}
export interface MergeResult {
  /** Flat map dotted-path -> value */
  values: Map<string, unknown>;
  origin: Map<string, Origin>;
  /** Attempts by lower layers to override a locked key. */
  blocked: { path: string; by: Origin; lockedAt: Origin }[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Flattens to leaf paths. Arrays and primitives are leaves. Path segments are escaped for dots. */
export function flatten(obj: Record<string, unknown>, prefix = ""): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const key = prefix ? `${prefix}.${escapeSeg(k)}` : escapeSeg(k);
    if (isPlainObject(v)) out.push(...flatten(v, key));
    else out.push([key, v]);
  }
  return out;
}

export const escapeSeg = (s: string) => s.replace(/\\/g, "\\\\").replace(/\./g, "\\.");
export function splitPath(path: string): string[] {
  const segs: string[] = [];
  let cur = "";
  for (let i = 0; i < path.length; i++) {
    const c = path[i];
    if (c === "\\" && i + 1 < path.length) {
      cur += path[++i];
    } else if (c === ".") {
      segs.push(cur);
      cur = "";
    } else cur += c;
  }
  segs.push(cur);
  return segs;
}

export function unflatten(values: Map<string, unknown>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [path, v] of values) {
    const segs = splitPath(path);
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i];
      if (!isPlainObject(node[s])) node[s] = {};
      node = node[s] as Record<string, unknown>;
    }
    node[segs[segs.length - 1]] = v;
  }
  return root;
}

const coversPath = (prefix: string, path: string) => path === prefix || path.startsWith(prefix + ".");

/** Sort layers deterministically: scope order, then group priority, then id. */
export function sortLayers(layers: ConfigLayer[]): ConfigLayer[] {
  return [...layers].sort(
    (a, b) =>
      SCOPE_ORDER[a.scopeType] - SCOPE_ORDER[b.scopeType] ||
      (a.priority ?? 0) - (b.priority ?? 0) ||
      a.scopeId.localeCompare(b.scopeId),
  );
}

const APP_STATE_PATH = /^apps\.(?:[^.\\]|\\.)+\.state$/;
const RESTRICTION_PATH = /^restrictions\./;

/**
 * Layered merge with locks and "most restrictive wins" between GROUP layers of equal priority
 * for security-relevant keys (app state, user restrictions).
 */
export function mergeLayers(layers: ConfigLayer[]): MergeResult {
  const values = new Map<string, unknown>();
  const origin = new Map<string, Origin>();
  const originPriority = new Map<string, number>();
  const locks: { prefix: string; at: Origin; scopeOrder: number }[] = [];
  const blocked: MergeResult["blocked"] = [];

  for (const layer of sortLayers(layers)) {
    const here: Origin = { scopeType: layer.scopeType, scopeId: layer.scopeId };
    const order = SCOPE_ORDER[layer.scopeType];
    for (const [path, v] of flatten(layer.values as Record<string, unknown>)) {
      const lock = locks.find((l) => l.scopeOrder < order && coversPath(l.prefix, path));
      if (lock) {
        blocked.push({ path, by: here, lockedAt: lock.at });
        continue;
      }
      // An object-valued path replaced by a scalar (or vice versa) must drop stale children.
      for (const existing of [...values.keys()]) {
        if (existing !== path && (coversPath(path, existing) || coversPath(existing, path))) {
          values.delete(existing);
          origin.delete(existing);
        }
      }
      const prev = origin.get(path);
      const sameGroupTier =
        prev?.scopeType === "GROUP" &&
        layer.scopeType === "GROUP" &&
        originPriority.get(path) === (layer.priority ?? 0);
      if (sameGroupTier && APP_STATE_PATH.test(path)) {
        const a = values.get(path) as AppDesiredState;
        const b = v as AppDesiredState;
        if (APP_STATE_RESTRICTIVENESS[a] >= APP_STATE_RESTRICTIVENESS[b]) continue;
      }
      if (sameGroupTier && RESTRICTION_PATH.test(path) && values.get(path) === true && v === false) {
        continue;
      }
      values.set(path, v);
      origin.set(path, here);
      originPriority.set(path, layer.priority ?? 0);
    }
    for (const k of layer.lockedKeys ?? []) locks.push({ prefix: k, at: here, scopeOrder: order });
  }
  return { values, origin, blocked };
}
