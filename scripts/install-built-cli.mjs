#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliRoot = path.join(repoRoot, "dist", "apps", "cli");
const packagePath = path.join(cliRoot, "package.json");

if (!fs.existsSync(packagePath)) {
    console.error(`Missing built CLI at ${cliRoot}. Run "pnpm run cli:build" first.`);
    process.exit(1);
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const args = ["add", "--global"];
const globalDir = process.env.RAIKEN_GLOBAL_DIR;
const globalBinDir = process.env.RAIKEN_GLOBAL_BIN_DIR;
if (globalDir) args.push("--global-dir", path.resolve(globalDir));
if (globalBinDir) args.push("--global-bin-dir", path.resolve(globalBinDir));
args.push(cliRoot);

const env = { ...process.env };
if (globalBinDir) {
    env.PATH = `${path.resolve(globalBinDir)}${path.delimiter}${env.PATH ?? ""}`;
}

const result = spawnSync(pnpm, args, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
});
if (result.error) {
    console.error(result.error.message);
    process.exit(1);
}
if (result.status !== 0) {
    process.exit(result.status ?? 1);
}

// Post-install sanity check: an older raiken installed through a different
// package manager (npm, Homebrew, …) earlier on PATH silently shadows this
// fresh install — same version number, missing features. Warn explicitly so
// nobody dogfoods a stale binary.
if (process.platform !== "win32") {
    const binDir =
        globalBinDir ?? spawnSync(pnpm, ["bin", "--global"], { encoding: "utf8" }).stdout?.trim();
    // Resolve with the user's PATH (process.env), not the install env — the
    // install env prepends the fresh bin dir, which would hide a shadowing
    // older install further down the real PATH.
    const which = spawnSync("which", ["-a", "raiken"], { encoding: "utf8" });
    const firstOnPath = which.stdout
        ?.split("\n")
        .map((line) => line.trim())
        .find(Boolean);
    if (binDir && firstOnPath && !firstOnPath.startsWith(path.resolve(binDir))) {
        console.warn(
            `\n⚠ Installed to ${binDir}, but \`raiken\` on your PATH resolves to ${firstOnPath}.\n` +
                "  That older install shadows this one — remove it (e.g. `npm rm -g raiken` " +
                "or delete the shim) or fix your PATH order, then run `raiken --help` to verify.",
        );
    }
}
process.exit(0);
