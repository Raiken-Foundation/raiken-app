import fs from "node:fs";
import path from "node:path";

const FALLBACK_VERSION = "0.0.0";

function readVersionFromPackageJson(pkgPath: string): string | null {
    try {
        const raw = fs.readFileSync(pkgPath, "utf-8");
        const pkg = JSON.parse(raw) as { name?: string; version?: string };
        if (typeof pkg.version !== "string" || pkg.version.length === 0) {
            return null;
        }
        if (
            pkg.name === "raiken" ||
            pkgPath.endsWith(`${path.sep}apps${path.sep}cli${path.sep}package.json`)
        ) {
            return pkg.version;
        }
        if (pkgPath.includes(`${path.sep}dist${path.sep}apps${path.sep}cli${path.sep}`)) {
            return pkg.version;
        }
    } catch {
        // Missing or unreadable package.json — try the next candidate.
    }
    return null;
}

/**
 * Canonical Raiken release version. Reads `apps/cli/package.json` in the
 * monorepo and the generated `package.json` beside the bundled CLI artifact.
 */
export function getRaikenVersion(): string {
    const candidates = [
        path.join(__dirname, "package.json"),
        path.resolve(__dirname, "../../../../apps/cli/package.json"),
        path.resolve(process.cwd(), "apps/cli/package.json"),
        path.resolve(process.cwd(), "dist/apps/cli/package.json"),
    ];

    for (const candidate of candidates) {
        const version = readVersionFromPackageJson(candidate);
        if (version) {
            return version;
        }
    }

    return FALLBACK_VERSION;
}
