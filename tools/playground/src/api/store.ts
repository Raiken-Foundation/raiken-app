// In-memory store backing the mock API.
//
// All API entry points (see ./client.ts) read and mutate this store after a
// realistic latency window. Persisting to localStorage would be more
// "correct" but it complicates Playwright test isolation, so the store is
// intentionally re-seeded in memory on every page load.

import type { ActivityEntry, Comment, Project, Task, User } from "../types";
import { SEED_ACTIVITY, SEED_COMMENTS, SEED_PROJECTS, SEED_TASKS, SEED_USERS } from "./seed";

interface Store {
    users: User[];
    projects: Project[];
    tasks: Task[];
    comments: Comment[];
    activity: ActivityEntry[];
}

const cloneArray = <T>(items: T[]): T[] => items.map((item) => ({ ...item }));

export const store: Store = {
    users: cloneArray(SEED_USERS),
    projects: cloneArray(SEED_PROJECTS),
    tasks: cloneArray(SEED_TASKS),
    comments: cloneArray(SEED_COMMENTS),
    activity: cloneArray(SEED_ACTIVITY),
};

export function resetStore(): void {
    store.users = cloneArray(SEED_USERS);
    store.projects = cloneArray(SEED_PROJECTS);
    store.tasks = cloneArray(SEED_TASKS);
    store.comments = cloneArray(SEED_COMMENTS);
    store.activity = cloneArray(SEED_ACTIVITY);
}
