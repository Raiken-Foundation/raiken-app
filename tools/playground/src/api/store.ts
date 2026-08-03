/**
 * In-memory data store for the Orbit fixture. A single mutable module-level
 * DB (seeded deterministically) so every page sees the same mutations during
 * one browser session; reloads reset to the seed. Fixed latency simulates a
 * real API without nondeterminism.
 */
import type {
    ActivityEntry,
    Comment,
    Project,
    Task,
    User,
} from "../types";
import {
    ACTIVITY,
    COMMENTS,
    PROJECTS,
    TASKS,
    USERS,
    type SeedTask,
} from "./seed";

interface OrbitDB {
    users: User[];
    projects: Project[];
    tasks: Task[];
    comments: Comment[];
    activity: ActivityEntry[];
}

const taskFromSeed = (seed: SeedTask): Task => ({
    id: seed.id,
    projectId: seed.projectId,
    title: seed.title,
    description: seed.description,
    status: seed.status,
    priority: seed.priority,
    assigneeId: seed.assigneeId,
    createdAt: new Date(
        Date.parse("2026-04-01T00:00:00.000Z") + seed.createdOffsetDays * 86_400_000,
    ).toISOString(),
    updatedAt: new Date(
        Date.parse("2026-04-01T00:00:00.000Z") + seed.updatedOffsetDays * 86_400_000,
    ).toISOString(),
});

const seedDb = (): OrbitDB => ({
    users: [...USERS],
    projects: [...PROJECTS],
    tasks: TASKS.map(taskFromSeed),
    comments: [...COMMENTS],
    activity: [...ACTIVITY],
});

let db: OrbitDB = seedDb();

export function resetDb(): void {
    db = seedDb();
}

export function getDb(): OrbitDB {
    return db;
}
