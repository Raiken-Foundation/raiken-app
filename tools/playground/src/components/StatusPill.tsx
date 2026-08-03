import type { ProjectStatus, TaskPriority, TaskStatus } from "../types";

const STATUS_LABEL: Record<TaskStatus, string> = {
    todo: "To do",
    in_progress: "In progress",
    review: "In review",
    done: "Done",
};

export function StatusPill({ status }: { status: TaskStatus }) {
    return <span className={`pill pill-status pill-${status}`}>{STATUS_LABEL[status]}</span>;
}

const PROJECT_LABEL: Record<ProjectStatus, string> = {
    active: "Active",
    completed: "Completed",
    archived: "Archived",
};

export function ProjectStatusPill({ status }: { status: ProjectStatus }) {
    return (
        <span className={`pill pill-project pill-${status}`}>{PROJECT_LABEL[status]}</span>
    );
}

const PRIORITY_LABEL: Record<TaskPriority, string> = {
    low: "Low",
    medium: "Medium",
    high: "High",
    urgent: "Urgent",
};

export function PriorityBadge({ priority }: { priority: TaskPriority }) {
    return <span className={`pill pill-priority pill-${priority}`}>{PRIORITY_LABEL[priority]}</span>;
}
