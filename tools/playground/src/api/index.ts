/**
 * Async API surface for the Orbit fixture. Every call simulates a fixed
 * network latency and returns deep copies, so callers can never mutate the
 * store directly. RBAC enforcement lives here too — a viewer hitting a write
 * endpoint gets a 403-shaped rejection even if the UI forgot to hide a
 * button, which keeps permission bugs detectable by tests.
 */
import type {
    ActivityEntry,
    Comment,
    Project,
    ProjectStats,
    ProjectTaskCounts,
    Task,
    TaskPriority,
    TaskStatus,
    User,
} from "../types";
import { computeStats, SEED_PASSWORD } from "./seed";
import { getDb, resetDb } from "./store";

const LATENCY_MS = 120;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextId(prefix: string): string {
    // Deterministic per-browser-session ids (monotonic, seeded by the clock —
    // fine for a fixture; never asserted as stable strings by tests).
    return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** The anchor the fixture renders relative dates against. */
export const FIXTURE_ANCHOR = Date.parse("2026-04-01T00:00:00.000Z");

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface LoginResult {
    user: User;
    issuedAt: string;
}

export async function login(username: string, password: string): Promise<LoginResult> {
    await sleep(LATENCY_MS);
    const user = getDb().users.find(
        (u) => u.username.toLowerCase() === username.trim().toLowerCase(),
    );
    if (!user || password !== SEED_PASSWORD) {
        throw new Error("Invalid username or password.");
    }
    return { user: clone(user), issuedAt: new Date(FIXTURE_ANCHOR).toISOString() };
}

export async function listUsers(): Promise<User[]> {
    await sleep(LATENCY_MS);
    return clone(getDb().users);
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface ProjectFilters {
    query?: string;
    status?: "active" | "completed" | "archived";
}

export async function listProjects(filters: ProjectFilters = {}): Promise<Project[]> {
    await sleep(LATENCY_MS);
    let projects = getDb().projects;
    const query = (filters.query ?? "").trim().toLowerCase();
    if (query) {
        projects = projects.filter(
            (p) =>
                p.name.toLowerCase().includes(query) ||
                p.description.toLowerCase().includes(query),
        );
    }
    if (filters.status) {
        projects = projects.filter((p) => p.status === filters.status);
    }
    return clone(projects);
}

export async function getProject(slug: string): Promise<Project | null> {
    await sleep(LATENCY_MS);
    const project = getDb().projects.find((p) => p.slug === slug);
    return project ? clone(project) : null;
}

export async function createProject(input: {
    name: string;
    description: string;
    actor: User;
}): Promise<Project> {
    await sleep(LATENCY_MS);
    if (input.actor.role !== "admin") throw new Error("Only admins can create projects.");
    const slug = input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    if (getDb().projects.some((p) => p.slug === slug)) {
        throw new Error(`A project named "${input.name}" already exists.`);
    }
    const now = new Date(FIXTURE_ANCHOR).toISOString();
    const project: Project = {
        id: nextId("p"),
        slug,
        name: input.name,
        description: input.description,
        status: "active",
        ownerId: input.actor.id,
        teamIds: [input.actor.id],
        createdAt: now,
        updatedAt: now,
    };
    getDb().projects.push(project);
    pushActivity(input.actor.id, project.id, `created project ${project.name}`);
    return clone(project);
}

export async function archiveProject(slug: string, actor: User): Promise<Project> {
    await sleep(LATENCY_MS);
    const project = getDb().projects.find((p) => p.slug === slug);
    if (!project) throw new Error("Project not found.");
    if (actor.role !== "admin") throw new Error("Only admins can archive projects.");
    project.status = "archived";
    project.updatedAt = new Date(FIXTURE_ANCHOR).toISOString();
    pushActivity(actor.id, project.id, `archived project ${project.name}`);
    return clone(project);
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export async function listTasks(projectSlug: string): Promise<Task[]> {
    await sleep(LATENCY_MS);
    const project = getDb().projects.find((p) => p.slug === projectSlug);
    if (!project) return [];
    return clone(getDb().tasks.filter((t) => t.projectId === project.id));
}

export async function taskCountsByProject(): Promise<Record<string, ProjectTaskCounts>> {
    await sleep(LATENCY_MS);
    const counts: Record<string, ProjectTaskCounts> = {};
    for (const project of getDb().projects) {
        const tasks = getDb().tasks.filter((t) => t.projectId === project.id);
        counts[project.id] = {
            todo: tasks.filter((t) => t.status === "todo").length,
            in_progress: tasks.filter((t) => t.status === "in_progress").length,
            review: tasks.filter((t) => t.status === "review").length,
            done: tasks.filter((t) => t.status === "done").length,
        };
    }
    return clone(counts);
}

export async function createTask(input: {
    projectSlug: string;
    title: string;
    description: string;
    priority: TaskPriority;
    assigneeId: string | null;
    actor: User;
}): Promise<Task> {
    await sleep(LATENCY_MS);
    if (input.actor.role === "viewer") throw new Error("Viewers cannot create tasks.");
    const project = getDb().projects.find((p) => p.slug === input.projectSlug);
    if (!project) throw new Error("Project not found.");
    const now = new Date(FIXTURE_ANCHOR).toISOString();
    const task: Task = {
        id: nextId("t"),
        projectId: project.id,
        title: input.title,
        description: input.description,
        status: "todo",
        priority: input.priority,
        assigneeId: input.assigneeId,
        createdAt: now,
        updatedAt: now,
    };
    getDb().tasks.push(task);
    pushActivity(input.actor.id, project.id, `created task ${project.name} / ${task.title}`);
    return clone(task);
}

export async function updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    actor: User,
): Promise<Task> {
    await sleep(LATENCY_MS);
    if (actor.role === "viewer") throw new Error("Viewers cannot update tasks.");
    const task = getDb().tasks.find((t) => t.id === taskId);
    if (!task) throw new Error("Task not found.");
    task.status = status;
    task.updatedAt = new Date(FIXTURE_ANCHOR).toISOString();
    const project = getDb().projects.find((p) => p.id === task.projectId);
    pushActivity(
        actor.id,
        task.projectId,
        `moved ${project?.name ?? "task"} / ${task.title} to ${statusLabel(status)}`,
    );
    return clone(task);
}

export async function updateTaskAssignee(
    taskId: string,
    assigneeId: string | null,
    actor: User,
): Promise<Task> {
    await sleep(LATENCY_MS);
    if (actor.role === "viewer") throw new Error("Viewers cannot update tasks.");
    const task = getDb().tasks.find((t) => t.id === taskId);
    if (!task) throw new Error("Task not found.");
    task.assigneeId = assigneeId;
    task.updatedAt = new Date(FIXTURE_ANCHOR).toISOString();
    const project = getDb().projects.find((p) => p.id === task.projectId);
    pushActivity(
        actor.id,
        task.projectId,
        `assigned ${task.title} in ${project?.name ?? "project"}`,
    );
    return clone(task);
}

export function statusLabel(status: TaskStatus): string {
    switch (status) {
        case "todo":
            return "To do";
        case "in_progress":
            return "In progress";
        case "review":
            return "In review";
        case "done":
            return "Done";
    }
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export async function listComments(taskId: string): Promise<Comment[]> {
    await sleep(LATENCY_MS);
    return clone(getDb().comments.filter((c) => c.taskId === taskId));
}

export async function addComment(input: {
    taskId: string;
    body: string;
    actor: User;
}): Promise<Comment> {
    await sleep(LATENCY_MS);
    if (input.actor.role === "viewer") throw new Error("Viewers cannot comment.");
    if (!input.body.trim()) throw new Error("Comment cannot be empty.");
    const task = getDb().tasks.find((t) => t.id === input.taskId);
    const comment: Comment = {
        id: nextId("c"),
        taskId: input.taskId,
        authorId: input.actor.id,
        body: input.body.trim(),
        createdAt: new Date(FIXTURE_ANCHOR).toISOString(),
    };
    getDb().comments.push(comment);
    if (task) {
        const project = getDb().projects.find((p) => p.id === task.projectId);
        pushActivity(
            input.actor.id,
            task.projectId,
            `commented on ${project?.name ?? "project"} / ${task.title}`,
        );
    }
    return clone(comment);
}

// ---------------------------------------------------------------------------
// Team / workspace
// ---------------------------------------------------------------------------

export async function setUserRole(userId: string, role: User["role"], actor: User): Promise<User> {
    await sleep(LATENCY_MS);
    if (actor.role !== "admin") throw new Error("Only admins can change roles.");
    const user = getDb().users.find((u) => u.id === userId);
    if (!user) throw new Error("User not found.");
    if (user.id === actor.id) throw new Error("You cannot change your own role.");
    user.role = role;
    pushActivity(actor.id, null, `changed the role of ${user.displayName} to ${role}`);
    return clone(user);
}

export async function removeUser(userId: string, actor: User): Promise<void> {
    await sleep(LATENCY_MS);
    if (actor.role !== "admin") throw new Error("Only admins can remove members.");
    const user = getDb().users.find((u) => u.id === userId);
    if (!user) throw new Error("User not found.");
    if (user.id === actor.id) throw new Error("You cannot remove yourself.");
    getDb().users = getDb().users.filter((u) => u.id !== userId);
    pushActivity(actor.id, null, `removed ${user.displayName} from the workspace`);
}

// ---------------------------------------------------------------------------
// Activity / stats
// ---------------------------------------------------------------------------

export async function listActivity(): Promise<ActivityEntry[]> {
    await sleep(LATENCY_MS);
    return clone(getDb().activity);
}

export async function getStats(): Promise<ProjectStats> {
    await sleep(LATENCY_MS);
    const db = getDb();
    return computeStats(db.projects, db.tasks);
}

export async function clearActivity(actor: User): Promise<void> {
    await sleep(LATENCY_MS);
    if (actor.role !== "admin") throw new Error("Only admins can clear the activity feed.");
    getDb().activity = [];
    pushActivity(actor.id, null, "cleared the activity feed");
}

/** Reseed the fixture (admin-only, used by settings for testing demos). */
export async function reseedFixture(actor: User): Promise<void> {
    await sleep(LATENCY_MS);
    if (actor.role !== "admin") throw new Error("Only admins can reset the fixture.");
    resetDb();
}

function pushActivity(actorId: string, projectId: string | null, message: string): void {
    getDb().activity.unshift({
        id: nextId("a"),
        actorId,
        projectId,
        message,
        createdAt: new Date(FIXTURE_ANCHOR).toISOString(),
    });
}
