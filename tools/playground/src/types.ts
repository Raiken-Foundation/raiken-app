// Domain types for the playground project tracker.
//
// The shape of these types is deliberately verbose so the code graph has
// useful symbols for `raiken cover` and `raiken trace` to resolve to.

export type Role = "admin" | "member";

export interface User {
    id: string;
    username: string;
    email: string;
    role: Role;
    avatarColor: string;
}

export type ProjectStatus = "active" | "archived" | "on_hold";

export interface Project {
    id: string;
    name: string;
    slug: string;
    description: string;
    status: ProjectStatus;
    ownerId: string;
    memberIds: string[];
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
    dueDate: string | null;
    createdAt: string;
    updatedAt: string;
}

export type ActivityKind =
    | "project_created"
    | "task_created"
    | "task_status_changed"
    | "task_assigned"
    | "comment_added"
    | "member_added";

export interface ActivityEntry {
    id: string;
    projectId: string;
    actorId: string;
    kind: ActivityKind;
    summary: string;
    timestamp: string;
}

export interface Comment {
    id: string;
    taskId: string;
    authorId: string;
    body: string;
    createdAt: string;
}

export interface Pagination<T> {
    items: T[];
    total: number;
    page: number;
    pageSize: number;
}

export type ContactMessage = {
    name: string;
    email: string;
    subject: string;
    message: string;
};
