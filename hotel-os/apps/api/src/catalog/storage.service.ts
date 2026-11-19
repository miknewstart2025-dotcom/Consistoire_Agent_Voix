import { Inject, Injectable } from "@nestjs/common";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { APP_CONFIG, type AppConfig } from "../config";

/**
 * Object storage for APKs (content-addressed by sha256).
 * Driver: local filesystem (STORAGE_DIR). An S3-compatible driver is the production target (PROGRESS.md);
 * the interface is kept minimal so it can be swapped without touching callers.
 */
@Injectable()
export class StorageService {
  readonly root: string;
  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    this.root = resolve(cfg.STORAGE_DIR);
  }
  private pathFor(key: string) {
    if (!/^[a-z]+\/[a-f0-9]{64}\.apk$/.test(key)) throw new Error(`invalid storage key ${key}`);
    return join(this.root, key);
  }
  async put(key: string, data: Buffer): Promise<void> {
    const p = this.pathFor(key);
    await mkdir(join(p, ".."), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, p);
  }
  async exists(key: string) {
    return stat(this.pathFor(key)).then(() => true, () => false);
  }
  localPath(key: string) {
    return this.pathFor(key);
  }
}
