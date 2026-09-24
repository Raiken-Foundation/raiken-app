import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Write a file atomically: hidden sibling temp then rename over the target.
 */
export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${randomUUID()}`);
    try {
        await fs.writeFile(tmp, data, { encoding: "utf-8", flag: "wx" });
        await fs.rename(tmp, filePath);
    } finally {
        await fs.unlink(tmp).catch(() => {});
    }
}
