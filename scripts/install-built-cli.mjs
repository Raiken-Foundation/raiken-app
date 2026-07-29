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
process.exit(result.status ?? 1);
