// Mock API client.
//
// Every call introduces a small randomised delay so the UI must show real
// loading states (no synchronous data). A small failure rate is configurable
// via window.__playgroundFailureRate so Playwright tests can opt in to
// network-error scenarios.
//
// Errors thrown here include the file path in their stack frames, which
// gives `raiken trace` something realistic to chew on.

import type {
    ActivityEntry,
    Comment,
    Pagination,
    Project,
    ProjectStatus,
    Task,
    TaskPriority,
    TaskStatus,
    User,
} from "../types";
import { store } from "./store";

declare global {
    interface Window {
        __playgroundFailureRate?: number;
        __playgroundLatency?: { min: number; max: number };
    }
}

export class ApiError extends Error {
    constructor(
        message: string,
        readonly code: "not_found" | "validation" | "forbidden" | "network",
    ) {
        super(message);
        this.name = "ApiError";
    }
}

function randomDelay(): number {
    const cfg = typeof window !== "undefined" ? window.__playgroundLatency : undefined;
    const min = cfg?.min ?? 120;
    const max = cfg?.max ?? 320;
    return min + Math.random() * Math.max(0, max - min);
}

function maybeFail(): void {
    const rate =
        typeof window !== "undefined" && typeof window.__playgroundFailureRate === "number"
            ? window.__playgroundFailureRate
            : 0;
    if (rate > 0 && Math.random() < rate) {
        throw new ApiError("simulated network failure", "network");
    }
}

async function call<T>(fn: () => T | Promise<T>): Promise<T> {
    await new Promise((resolve) => setTimeout(resolve, randomDelay()));
    maybeFail();
    return await fn();
}

function nextId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function nowIso(): string {
    return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface LoginCredentials {
    username: string;
    password: string;
}

export async function login({ username, password }: LoginCredentials): Promise<User> {
    return call(() => {
        if (!username || username.length < 3) {
            throw new ApiError("Username must be at least 3 characters", "validation");
        }
        if (!password || password.length < 4) {
            throw new ApiError("Password must be at least 4 characters", "validation");
        }
        const existing = store.users.find((u) => u.username === username);
        if (existing) return existing;
        // Auto-provision a member account so the playground is friendly to
        // first-time visitors.
        const created: User = {
            id: nextId("u"),
            username,
            email: `${username}@playground.dev`,
            role: "member",
            avatarColor: "#6366f1",
        };
        store.users.push(created);
        return created;
    });
}

export async function getCurrentUser(userId: string): Promise<User> {
    return call(() => {
        const user = store.users.find((u) => u.id === userId);
        if (!user) throw new ApiError("user not found", "not_found");
        return user;
    });
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface ListProjectsOptions {
    search?: string;
    status?: ProjectStatus | "all";
    sort?: "name" | "updated" | "status";
    direction?: "asc" | "desc";
    page?: number;
    pageSize?: number;
}

export async function listProjects(
    options: ListProjectsOptions = {},
): Promise<Pagination<Project>> {
    return call(() => {
        const search = options.search?.trim().toLowerCase() ?? "";
        const status = options.status ?? "all";
        const sort = options.sort ?? "updated";
        const direction = options.direction ?? "desc";
        const page = Math.max(1, options.page ?? 1);
        const pageSize = Math.max(1, Math.min(50, options.pageSize ?? 5));

        let items = [...store.projects];
        if (status !== "all") {
            items = items.filter((p) => p.status === status);
        }
        if (search) {
            items = items.filter(
                (p) =>
                    p.name.toLowerCase().includes(search) ||
                    p.description.toLowerCase().includes(search),
            );
        }
        items.sort((a, b) => {
            let cmp = 0;
            if (sort === "name") cmp = a.name.localeCompare(b.name);
            else if (sort === "status") cmp = a.status.localeCompare(b.status);
            else cmp = a.updatedAt.localeCompare(b.updatedAt);
            return direction === "asc" ? cmp : -cmp;
        });

        const total = items.length;
        const start = (page - 1) * pageSize;
        return {
            items: items.slice(start, start + pageSize),
            total,
            page,
            pageSize,
        };
    });
}

export async function getProject(projectId: string): Promise<Project> {
    return call(() => {
        const project = store.projects.find((p) => p.id === projectId);
        if (!project) throw new ApiError("project not found", "not_found");
        return project;
    });
}

export async function getProjectBySlug(slug: string): Promise<Project> {
    return call(() => {
        const project = store.projects.find((p) => p.slug === slug);
        if (!project) throw new ApiError("project not found", "not_found");
        return project;
    });
}

export interface CreateProjectInput {
    name: string;
    description: string;
    actor: User;
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
    return call(() => {
        if (input.actor.role !== "admin") {
            throw new ApiError("only admins can create projects", "forbidden");
        }
        if (!input.name || input.name.trim().length < 3) {
            throw new ApiError("project name must be at least 3 characters", "validation");
        }
        const slug = input.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40);
        if (store.projects.some((p) => p.slug === slug)) {
            throw new ApiError("a project with this name already exists", "validation");
        }
        const project: Project = {
            id: nextId("p"),
            name: input.name.trim(),
            slug,
            description: input.description.trim(),
            status: "active",
            ownerId: input.actor.id,
            memberIds: [input.actor.id],
            createdAt: nowIso(),
            updatedAt: nowIso(),
        };
        store.projects.unshift(project);
        store.activity.unshift({
            id: nextId("a"),
            projectId: project.id,
            actorId: input.actor.id,
            kind: "project_created",
            summary: `created project "${project.name}"`,
            timestamp: project.createdAt,
        });
        return project;
    });
}

export async function archiveProject(projectId: string, actor: User): Promise<Project> {
    return call(() => {
        if (actor.role !== "admin") {
            throw new ApiError("only admins can archive projects", "forbidden");
        }
        const project = store.projects.find((p) => p.id === projectId);
        if (!project) throw new ApiError("project not found", "not_found");
        project.status = "archived";
        project.updatedAt = nowIso();
        return project;
    });
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export interface ListTasksOptions {
    projectId: string;
    status?: TaskStatus | "all";
    assigneeId?: string | "any" | "unassigned";
    search?: string;
}

export async function listTasks(options: ListTasksOptions): Promise<Task[]> {
    return call(() => {
        const status = options.status ?? "all";
        const assignee = options.assigneeId ?? "any";
        const search = options.search?.trim().toLowerCase() ?? "";

        return store.tasks
            .filter((t) => t.projectId === options.projectId)
            .filter((t) => (status === "all" ? true : t.status === status))
            .filter((t) =>
                assignee === "any"
                    ? true
                    : assignee === "unassigned"
                      ? t.assigneeId === null
                      : t.assigneeId === assignee,
            )
            .filter((t) =>
                search
                    ? t.title.toLowerCase().includes(search) ||
                      t.description.toLowerCase().includes(search)
                    : true,
            )
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
}

export interface CreateTaskInput {
    projectId: string;
    title: string;
    description: string;
    priority: TaskPriority;
    assigneeId: string | null;
    dueDate: string | null;
    actor: User;
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
    return call(() => {
        if (!input.title || input.title.trim().length < 3) {
            throw new ApiError("task title must be at least 3 characters", "validation");
        }
        const project = store.projects.find((p) => p.id === input.projectId);
        if (!project) throw new ApiError("project not found", "not_found");
        if (input.assigneeId && !project.memberIds.includes(input.assigneeId)) {
            throw new ApiError("assignee is not a member of this project", "validation");
        }
        const task: Task = {
            id: nextId("t"),
            projectId: input.projectId,
            title: input.title.trim(),
            description: input.description.trim(),
            status: "todo",
            priority: input.priority,
            assigneeId: input.assigneeId,
            dueDate: input.dueDate,
            createdAt: nowIso(),
            updatedAt: nowIso(),
        };
        store.tasks.unshift(task);
        project.updatedAt = task.createdAt;
        store.activity.unshift({
            id: nextId("a"),
            projectId: project.id,
            actorId: input.actor.id,
            kind: "task_created",
            summary: `added task "${task.title}"`,
            timestamp: task.createdAt,
        });
        return task;
    });
}

export interface UpdateTaskStatusInput {
    taskId: string;
    status: TaskStatus;
    actor: User;
}

export async function updateTaskStatus({
    taskId,
    status,
    actor,
}: UpdateTaskStatusInput): Promise<Task> {
    return call(() => {
        const task = store.tasks.find((t) => t.id === taskId);
        if (!task) throw new ApiError("task not found", "not_found");
        if (task.status === status) return task;
        const previous = task.status;
        task.status = status;
        task.updatedAt = nowIso();
        const project = store.projects.find((p) => p.id === task.projectId);
        if (project) project.updatedAt = task.updatedAt;
        store.activity.unshift({
            id: nextId("a"),
            projectId: task.projectId,
            actorId: actor.id,
            kind: "task_status_changed",
            summary: `moved "${task.title}" from ${previous} to ${status}`,
            timestamp: task.updatedAt,
        });
        return task;
    });
}

export async function deleteTask(taskId: string, actor: User): Promise<void> {
    return call(() => {
        if (actor.role !== "admin") {
            throw new ApiError("only admins can delete tasks", "forbidden");
        }
        const idx = store.tasks.findIndex((t) => t.id === taskId);
        if (idx === -1) throw new ApiError("task not found", "not_found");
        store.tasks.splice(idx, 1);
    });
}

// ---------------------------------------------------------------------------
// Comments & activity
// ---------------------------------------------------------------------------

export async function listComments(taskId: string): Promise<Comment[]> {
    return call(() =>
        store.comments
            .filter((c) => c.taskId === taskId)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    );
}

export interface AddCommentInput {
    taskId: string;
    body: string;
    actor: User;
}

export async function addComment(input: AddCommentInput): Promise<Comment> {
    return call(() => {
        if (!input.body || input.body.trim().length < 1) {
            throw new ApiError("comment cannot be empty", "validation");
        }
        const task = store.tasks.find((t) => t.id === input.taskId);
        if (!task) throw new ApiError("task not found", "not_found");
        const comment: Comment = {
            id: nextId("c"),
            taskId: input.taskId,
            authorId: input.actor.id,
            body: input.body.trim(),
            createdAt: nowIso(),
        };
        store.comments.push(comment);
        store.activity.unshift({
            id: nextId("a"),
            projectId: task.projectId,
            actorId: input.actor.id,
            kind: "comment_added",
            summary: `commented on "${task.title}"`,
            timestamp: comment.createdAt,
        });
        return comment;
    });
}

export async function listActivity(projectId?: string): Promise<ActivityEntry[]> {
    return call(() =>
        store.activity.filter((a) => (projectId ? a.projectId === projectId : true)).slice(0, 30),
    );
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export async function listMembers(projectId: string): Promise<User[]> {
    return call(() => {
        const project = store.projects.find((p) => p.id === projectId);
        if (!project) throw new ApiError("project not found", "not_found");
        return store.users.filter((u) => project.memberIds.includes(u.id));
    });
}

export async function listAllUsers(): Promise<User[]> {
    return call(() => [...store.users]);
}
