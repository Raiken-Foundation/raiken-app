import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContractApplication } from "../application/contract";
import { commitsInRange, GitRangeError, readCommitStamp } from "../contract/commit";
import { ContractStore } from "../contract/store";
import { SqliteDbAdapter } from "../database/adapter";
import { CodeGraphDB } from "../database/db";

const FACT = {
    route: "/settings",
    precondition: null,
    action: "open /settings",
    expectedObservable: 'shows heading "Settings"',
    evidence: null,
    sourceCommit: null,
    capturedAt: 0,
    lastVerifiedAt: null,
    verifiedCount: 0,
    violatedCount: 0,
} as const;

function git(dir: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd: dir, encoding: "utf-8" }).trim();
}

function initRepo(dir: string): void {
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "test@raiken.dev");
    git(dir, "config", "user.name", "Raiken Test");
    git(dir, "config", "commit.gpgsign", "false");
    fs.writeFileSync(path.join(dir, ".gitignore"), ".raiken/\n");
}

function commit(dir: string, file: string, content: string, message: string): string {
    fs.writeFileSync(path.join(dir, file), content);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", message);
    return git(dir, "rev-parse", "HEAD");
}

describe("commit-stamped contract ledger", () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raiken-commits-")));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const withStore = <T>(
        fn: (store: ContractStore) => T,
        commitStamp?: { sha: string; dirty: boolean } | null,
    ): T => {
        const db = new CodeGraphDB(dir);
        try {
            const adapter = new SqliteDbAdapter(db.getRawDatabase(), dir);
            return fn(
                commitStamp === undefined
                    ? new ContractStore(adapter)
                    : new ContractStore(adapter, { commit: commitStamp }),
            );
        } finally {
            db.close();
        }
    };

    it("stamps every ledger event and a minted fact's source commit", () => {
        const sha = "a".repeat(40);
        withStore(
            (store) => {
                store.upsertBehaviorFact({ ...FACT, status: "verified" });
                store.upsertBehaviorFact({ ...FACT, status: "violated" });
            },
            { sha, dirty: true },
        );

        const events = withStore((store) => store.listFactEvents());
        expect(events.map((e) => [e.eventType, e.commitSha, e.commitDirty])).toEqual([
            ["violated", sha, true],
            ["minted", sha, true],
        ]);
        expect(withStore((store) => store.listBehaviorFacts()[0].sourceCommit)).toBe(sha);
    });

    it("records events unstamped outside git instead of failing", () => {
        expect(readCommitStamp(dir)).toBeNull();
        withStore((store) => store.upsertBehaviorFact({ ...FACT, status: "verified" }));
        const [event] = withStore((store) => store.listFactEvents());
        expect(event.eventType).toBe("minted");
        expect(event.commitSha).toBeUndefined();
    });

    it("upgrades a ledger created before commit stamping", () => {
        fs.mkdirSync(path.join(dir, ".raiken"));
        const legacy = new Database(path.join(dir, ".raiken", "raiken.db"));
        legacy.exec(`CREATE TABLE fact_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT, project_path TEXT NOT NULL, fact_key TEXT NOT NULL,
            event_type TEXT NOT NULL, detail TEXT, occurred_at INTEGER NOT NULL)`);
        legacy
            .prepare(
                "INSERT INTO fact_events (project_path, fact_key, event_type, occurred_at) VALUES (?, ?, ?, ?)",
            )
            .run(dir, "oldfact", "verified", 1);
        legacy.close();

        withStore((store) => store.upsertBehaviorFact({ ...FACT, status: "verified" }), {
            sha: "b".repeat(40),
            dirty: false,
        });
        const events = withStore((store) => store.listFactEvents());
        expect(events.find((e) => e.factKey === "oldfact")?.commitSha).toBeUndefined();
        expect(events.find((e) => e.eventType === "minted")).toMatchObject({
            commitSha: "b".repeat(40),
            commitDirty: false,
        });
    });

    it("reports behavior changes per commit, keeping uncommitted edits apart", () => {
        initRepo(dir);
        const base = commit(dir, "app.ts", "v0", "base");
        const a = commit(dir, "app.ts", "v1", "add settings page");
        const app = new ContractApplication(dir);

        // At A (clean): the fact is observed for the first time.
        withStore((store) => store.upsertBehaviorFact({ ...FACT, status: "verified" }));
        // Local edit on top of A breaks it.
        fs.writeFileSync(path.join(dir, "app.ts"), "v1-broken");
        expect(readCommitStamp(dir)).toEqual({ sha: a, dirty: true });
        withStore((store) => {
            const fact = store.listBehaviorFacts()[0];
            store.setBehaviorStatus(fact.id as number, "violated");
        });
        // B fixes it.
        const b = commit(dir, "app.ts", "v2", "fix settings heading");
        withStore((store) => {
            const fact = store.listBehaviorFacts()[0];
            store.setBehaviorStatus(fact.id as number, "verified");
            store.setBehaviorStatus(fact.id as number, "verified");
        });

        const changes = app.changes(`${base}..HEAD`);
        expect(changes.summary).toMatchObject({ added: 1, broke: 1, fixed: 1 });
        expect(changes.silentCommits).toBe(0);
        expect(
            changes.commits.map((c) => [
                c.sha,
                c.uncommitted,
                c.events.map((e) => e.transition),
                c.reverified,
            ]),
        ).toEqual([
            [a, false, ["added"], 0],
            [a, true, ["broke"], 0],
            [b, false, ["fixed"], 1],
        ]);
        expect(changes.commits[1].events[0]).toMatchObject({
            route: "/settings",
            expectedObservable: 'shows heading "Settings"',
        });

        // A range that stops at A sees only the mint.
        expect(app.changes(`${base}..${a}`).summary).toMatchObject({
            added: 1,
            broke: 1,
            fixed: 0,
        });
    });

    it("rejects an invalid range with a usable message", () => {
        initRepo(dir);
        commit(dir, "app.ts", "v0", "base");
        expect(() => commitsInRange(dir, "nope..HEAD")).toThrow(GitRangeError);
        // Option injection through an MCP-supplied range must not reach git.
        const target = path.join(dir, "written-by-git.txt");
        expect(() => commitsInRange(dir, `--output=${target}`)).toThrow(GitRangeError);
        expect(() => commitsInRange(dir, `HEAD..--output=${target}`)).toThrow(GitRangeError);
        expect(fs.existsSync(target)).toBe(false);
        expect(commitsInRange(dir, "HEAD..HEAD")).toEqual([]);
    });
});
