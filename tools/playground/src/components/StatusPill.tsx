import type { ProjectStatus, TaskPriority, TaskStatus } from "../types";

const PROJECT_LABELS: Record<ProjectStatus, string> = {
    active: "Active",
    archived: "Archived",
    on_hold: "On hold",
};

const TASK_LABELS: Record<TaskStatus, string> = {
    todo: "To do",
    in_progress: "In progress",
    review: "In review",
    done: "Done",
};

const PRIORITY_LABELS: Record<TaskPriority, string> = {
    low: "Low",
    medium: "Medium",
    high: "High",
    urgent: "Urgent",
};

export function ProjectStatusPill({ status }: { status: ProjectStatus }) {
    return (
        <span className={`pill pill-${status}`} data-testid={`project-status-${status}`}>
            {PROJECT_LABELS[status]}
        </span>
    );
}

export function TaskStatusPill({ status }: { status: TaskStatus }) {
    return (
        <span className={`pill pill-${status}`} data-testid={`task-status-${status}`}>
            {TASK_LABELS[status]}
        </span>
    );
}

export function PriorityPill({ priority }: { priority: TaskPriority }) {
    return (
        <span className={`pill pill-priority-${priority}`} data-testid={`priority-${priority}`}>
            {PRIORITY_LABELS[priority]}
        </span>
    );
}
