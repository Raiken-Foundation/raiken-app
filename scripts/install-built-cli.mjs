#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliRoot = path.join(repoRoot, "dist", "apps", "cli");

/**
 * pnpm aborts a global install when its global virtual store was created by a
 * different pnpm version/layout ("currently symlinked from the virtual store
 * directory" / "pnpm now wants to use the virtual store at"). The built CLI
 * ships its own node_modules, so the installer only links the package — npm
 * is an equivalent fallback that has no virtual-store concept.
 */
export function isVirtualStoreMismatch(output) {
    return /virtual store/i.test(output ?? "");
}

export function buildRemediation() {
    return (
        "\nGlobal install failed. Two common fixes:\n" +
        "  • Refresh pnpm's global store once:  pnpm install --global\n" +
        "  • Or install into a dedicated dir:   " +
        "RAIKEN_GLOBAL_DIR=~/.raiken-global RAIKEN_GLOBAL_BIN_DIR=~/.raiken-global/bin " +
        "node scripts/install-built-cli.mjs\n"
    );
}

function globalBinDirFor(pm) {
    if (process.platform === "win32") return null;
    if (pm === "npm") {
        const prefix = spawnSync("npm", ["prefix", "--global"], {
            encoding: "utf8",
        }).stdout?.trim();
        return prefix ? path.join(prefix, "bin") : null;
    }
    return spawnSync("pnpm", ["bin", "--global"], { encoding: "utf8" }).stdout?.trim() || null;
}

function warnIfShadowed(binDir) {
    if (process.platform === "win32" || !binDir) return;
    // Resolve with the user's PATH (process.env), not the install env — the
    // install env prepends the fresh bin dir, which would hide a shadowing
    // older install further down the real PATH.
    const which = spawnSync("which", ["-a", "raiken"], { encoding: "utf8" });
    const firstOnPath = which.stdout
        ?.split("\n")
        .map((line) => line.trim())
        .find(Boolean);
    if (firstOnPath && !firstOnPath.startsWith(path.resolve(binDir))) {
        console.warn(
            `\n⚠ Installed to ${binDir}, but \`raiken\` on your PATH resolves to ${firstOnPath}.\n` +
                "  That older install shadows this one — remove it (e.g. `npm rm -g raiken` " +
                "or delete the shim) or fix your PATH order, then run `raiken --help` to verify.",
        );
    }
}

function main() {
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

    // Output is captured, then replayed to the user — pnpm reports its
    // virtual-store refusal on STDOUT, so both streams are needed to
    // classify the failure, but the user must still see them either way.
    const attempt = spawnSync(pnpm, args, {
        cwd: repoRoot,
        env,
        encoding: "utf8",
        stdio: ["inherit", "pipe", "pipe"],
    });
    if (attempt.stdout) process.stdout.write(attempt.stdout);
    if (attempt.stderr) process.stderr.write(attempt.stderr);
    if (attempt.error) {
        console.error(attempt.error.message);
        process.exit(1);
    }

    let installedWith = "pnpm";

    if (attempt.status !== 0) {
        const canFallbackToNpm = !globalDir && !globalBinDir && process.platform !== "win32";
        const attemptOutput = `${attempt.stdout ?? ""}\n${attempt.stderr ?? ""}`;
        if (isVirtualStoreMismatch(attemptOutput) && canFallbackToNpm) {
            console.warn(
                "\n⚠ pnpm refused the global install: its global virtual store was created by " +
                    "another pnpm version.\n  Retrying with npm — the built CLI is self-contained, " +
                    "so the package manager only links it.\n",
            );
            const retry = spawnSync("npm", ["install", "--global", cliRoot], {
                cwd: repoRoot,
                env,
                stdio: "inherit",
            });
            if (retry.error) {
                console.error(retry.error.message);
                process.exit(1);
            }
            if (retry.status !== 0) {
                console.error(buildRemediation());
                process.exit(retry.status ?? 1);
            }
            installedWith = "npm";
        } else {
            console.error(buildRemediation());
            process.exit(attempt.status ?? 1);
        }
    }

    // Post-install sanity check: an older raiken installed through a different
    // package manager (npm, Homebrew, …) earlier on PATH silently shadows this
    // fresh install — same version number, missing features. Warn explicitly so
    // nobody dogfoods a stale binary.
    const binDir = globalBinDir ?? globalBinDirFor(installedWith);
    warnIfShadowed(binDir);
    process.exit(0);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
    main();
}
