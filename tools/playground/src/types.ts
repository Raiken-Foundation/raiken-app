/**
 * Domain types for the Orbit project suite — the raiken dogfood fixture.
 * Everything is deterministic (fixed ids, fixed timestamps) so E2E tests and
 * discovery behave identically on every run.
 */

export type Role = "admin" | "member" | "viewer";

export interface User {
    id: string;
    username: string;
    displayName: string;
    role: Role;
    email: string;
    /** Fixed anchor so "3 days ago" style rendering stays deterministic. */
    joinedAt: string;
}

export interface Session {
    user: User;
    /** Fixed for determinism; the login flow writes this to localStorage. */
    issuedAt: string;
}

export type ProjectStatus = "active" | "completed" | "archived";

export interface Project {
    id: string;
    slug: string;
    name: string;
    description: string;
    status: ProjectStatus;
    ownerId: string;
    teamIds: string[];
    createdAt: string;
    updatedAt: string;
}

export type TaskStatus = "todo" | "in_progress" | "review" | "done";
export type TaskPriority = "low" | "medium" | "high" | "urgent";

export interface Task {
    id: string;
    projectId: string;
    title: string;
    description: string;
    status: TaskStatus;
    priority: TaskPriority;
    assigneeId: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface Comment {
    id: string;
    taskId: string;
    authorId: string;
    body: string;
    createdAt: string;
}

export interface ActivityEntry {
    id: string;
    actorId: string;
    projectId: string | null;
    message: string;
    createdAt: string;
}

export interface ProjectStats {
    projects: number;
    activeProjects: number;
    openTasks: number;
    overdueTasks: number;
}

export interface ProjectTaskCounts {
    todo: number;
    in_progress: number;
    review: number;
    done: number;
}
