import { type CommitInfo, commitsInRange } from "./commit";
import type { ContractStore } from "./store";
import type { FactEvent } from "./types";

/**
 * Behavior changes between two commits, read from the commit-stamped ledger.
 *
 * Every ledger event carries the commit it was observed at, so the question
 * "what did the app start doing, stop doing, or get fixed between A and B"
 * becomes: the events stamped with a commit in A..B, grouped by commit and
 * classified against each fact's prior state. Events recorded on top of
 * uncommitted edits are kept apart from the commit's own, since they describe
 * "the commit plus local changes", not the commit.
 */

export type ContractTransition =
    | "added" // a fact was minted
    | "broke" // a holding fact was observed violated
    | "fixed" // a violated fact was observed holding again
    | "accepted" // a behavior change was accepted into the contract
    | "rejected" // a behavior change was rejected as a regression
    | "retired"
    | "forgotten"
    | "restored";

export interface ContractChangeEvent {
    factKey: string;
    eventType: FactEvent["eventType"];
    transition: ContractTransition | null;
    route?: string;
    action?: string;
    expectedObservable?: string;
    detail?: string;
    occurredAt: number;
}

export interface ContractCommitChanges {
    sha: string;
    subject: string;
    committedAt: number;
    /** Events recorded on top of uncommitted edits at this commit. */
    uncommitted: boolean;
    /** Transitions and other notable events, oldest first. */
    events: ContractChangeEvent[];
    /** Re-verifications of facts that already held (counted, not listed). */
    reverified: number;
}

export interface ContractChanges {
    range: string;
    commits: ContractCommitChanges[];
    /** Distinct facts per transition across the range. */
    summary: Record<ContractTransition, number>;
    /** Commits in the range with no ledger events. */
    silentCommits: number;
}

const HOLDING = new Set(["minted", "verified", "accepted", "restored"]);

export function computeContractChanges(
    store: ContractStore,
    projectPath: string,
    range: string,
    options: { commits?: CommitInfo[] } = {},
): ContractChanges {
    const commits = options.commits ?? commitsInRange(projectPath, range);
    const events = store.listFactEventsByCommits(commits.map((c) => c.sha));
    const facts = new Map(store.listBehaviorFacts().map((f) => [f.factKey, f]));

    const groups = new Map<string, ContractCommitChanges>();
    const touched: Record<ContractTransition, Set<string>> = {
        added: new Set(),
        broke: new Set(),
        fixed: new Set(),
        accepted: new Set(),
        rejected: new Set(),
        retired: new Set(),
        forgotten: new Set(),
        restored: new Set(),
    };

    for (const event of events) {
        const commit = commits.find((c) => c.sha === event.commitSha);
        if (!commit) continue;
        const uncommitted = event.commitDirty === true;
        const key = `${commit.sha}:${uncommitted ? 1 : 0}`;
        let group = groups.get(key);
        if (!group) {
            group = { ...commit, uncommitted, events: [], reverified: 0 };
            groups.set(key, group);
        }

        const transition = classify(store, event);
        if (event.eventType === "verified" && transition === null) {
            group.reverified++;
            continue;
        }
        if (event.eventType === "unverified") continue;
        if (event.eventType === "violated" && transition === null) continue; // still broken

        if (transition) touched[transition].add(event.factKey);
        const fact = facts.get(event.factKey);
        group.events.push({
            factKey: event.factKey,
            eventType: event.eventType,
            transition,
            route: fact?.route,
            action: fact?.action,
            expectedObservable: fact?.expectedObservable,
            detail: event.detail,
            occurredAt: event.occurredAt,
        });
    }

    // Commit order, each commit's own events before its uncommitted ones.
    const ordered = Array.from(groups.values()).sort((a, b) => {
        const ia = commits.findIndex((c) => c.sha === a.sha);
        const ib = commits.findIndex((c) => c.sha === b.sha);
        return ia - ib || Number(a.uncommitted) - Number(b.uncommitted);
    });
    const withEvents = new Set(ordered.map((g) => g.sha));

    return {
        range,
        commits: ordered,
        summary: Object.fromEntries(Object.entries(touched).map(([k, v]) => [k, v.size])) as Record<
            ContractTransition,
            number
        >,
        silentCommits: commits.filter((c) => !withEvents.has(c.sha)).length,
    };
}

function classify(store: ContractStore, event: FactEvent): ContractTransition | null {
    switch (event.eventType) {
        case "minted":
            return "added";
        case "accepted":
        case "rejected":
        case "retired":
        case "forgotten":
        case "restored":
            return event.eventType;
        case "violated":
        case "verified": {
            const prior =
                event.id !== undefined ? store.previousFactEvent(event.factKey, event.id) : null;
            const wasHolding = !prior || HOLDING.has(prior.eventType);
            if (event.eventType === "violated") return wasHolding ? "broke" : null;
            return prior?.eventType === "violated" ? "fixed" : null;
        }
        default:
            return null;
    }
}
