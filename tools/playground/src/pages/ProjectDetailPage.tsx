import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
    ApiError,
    archiveProject,
    deleteTask,
    getProjectBySlug,
    listActivity,
    listMembers,
    listTasks,
    updateTaskStatus,
} from "../api";
import Avatar from "../components/Avatar";
import ConfirmDialog from "../components/ConfirmDialog";
import { ProjectStatusPill } from "../components/StatusPill";
import Tabs, { type TabDefinition } from "../components/Tabs";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import type { ActivityEntry, Project, Task, TaskStatus, User } from "../types";
import ActivityPanel from "./project-detail/ActivityPanel";
import MembersPanel from "./project-detail/MembersPanel";
import OverviewPanel from "./project-detail/OverviewPanel";
import TaskListPanel from "./project-detail/TaskListPanel";

type TabId = "overview" | "tasks" | "members" | "activity";

export default function ProjectDetailPage() {
    const { slug } = useParams<{ slug: string }>();
    const { user, isAdmin } = useAuth();
    const { push } = useToast();
    const navigate = useNavigate();

    const [project, setProject] = useState<Project | null>(null);
    const [tasks, setTasks] = useState<Task[]>([]);
    const [members, setMembers] = useState<User[]>([]);
    const [activity, setActivity] = useState<ActivityEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [tab, setTab] = useState<TabId>("overview");
    const [confirmArchive, setConfirmArchive] = useState(false);

    useEffect(() => {
        if (!slug) return;
        let cancelled = false;
        async function load() {
            setLoading(true);
            setError(null);
            try {
                const proj = await getProjectBySlug(slug as string);
                if (cancelled) return;
                setProject(proj);
                const [t, m, a] = await Promise.all([
                    listTasks({ projectId: proj.id }),
                    listMembers(proj.id),
                    listActivity(proj.id),
                ]);
                if (cancelled) return;
                setTasks(t);
                setMembers(m);
                setActivity(a);
            } catch (err) {
                if (!cancelled) {
                    setError(err instanceof ApiError ? err.message : "Failed to load project");
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        }
        load();
        return () => {
            cancelled = true;
        };
    }, [slug]);

    const refreshTasksAndActivity = async () => {
        if (!project) return;
        const [t, a] = await Promise.all([
            listTasks({ projectId: project.id }),
            listActivity(project.id),
        ]);
        setTasks(t);
        setActivity(a);
    };

    const refreshMembersAndActivity = async () => {
        if (!project) return;
        const [updatedProject, nextMembers, nextActivity] = await Promise.all([
            getProjectBySlug(project.slug),
            listMembers(project.id),
            listActivity(project.id),
        ]);
        setProject({ ...updatedProject, memberIds: [...updatedProject.memberIds] });
        setMembers(nextMembers);
        setActivity(nextActivity);
    };

    const handleStatusChange = async (taskId: string, status: TaskStatus) => {
        if (!user) return;
        try {
            await updateTaskStatus({ taskId, status, actor: user });
            push("success", "Task updated");
            await refreshTasksAndActivity();
        } catch (err) {
            push("error", err instanceof ApiError ? err.message : "Failed to update task");
        }
    };

    const handleDelete = async (taskId: string) => {
        if (!user) return;
        try {
            await deleteTask(taskId, user);
            push("success", "Task deleted");
            await refreshTasksAndActivity();
        } catch (err) {
            push("error", err instanceof ApiError ? err.message : "Failed to delete task");
        }
    };

    const handleArchive = async () => {
        if (!project || !user) return;
        try {
            const updated = await archiveProject(project.id, user);
            setProject({ ...updated, memberIds: [...updated.memberIds] });
            push("success", "Project archived");
        } catch (err) {
            push("error", err instanceof ApiError ? err.message : "Failed to archive project");
        } finally {
            setConfirmArchive(false);
        }
    };

    if (loading) {
        return (
            <div className="page" data-testid="project-loading">
                Loading project…
            </div>
        );
    }

    if (error || !project) {
        return (
            <div className="page" data-testid="project-error">
                <div className="alert alert-error" role="alert">
                    {error ?? "Project not found"}
                </div>
                <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => navigate("/projects")}
                >
                    Back to projects
                </button>
            </div>
        );
    }

    const openTasks = tasks.filter((t) => t.status !== "done").length;

    const tabs: TabDefinition[] = [
        { id: "overview", label: "Overview" },
        { id: "tasks", label: "Tasks", badge: openTasks },
        { id: "members", label: "Members", badge: members.length },
        { id: "activity", label: "Activity", badge: activity.length },
    ];

    return (
        <div className="page" data-testid="project-detail-page">
            <header className="page-header">
                <div>
                    <div className="breadcrumb">
                        <Link to="/projects">Projects</Link>
                        <span aria-hidden="true">/</span>
                        <span>{project.name}</span>
                    </div>
                    <h1 data-testid="project-name">{project.name}</h1>
                    <p className="page-subtitle">{project.description}</p>
                    <div className="page-meta">
                        <ProjectStatusPill status={project.status} />
                        <span className="muted">
                            Updated {new Date(project.updatedAt).toLocaleDateString()}
                        </span>
                    </div>
                </div>
                {isAdmin && project.status !== "archived" && (
                    <button
                        type="button"
                        className="btn btn-danger"
                        onClick={() => setConfirmArchive(true)}
                        data-testid="archive-project"
                    >
                        Archive project
                    </button>
                )}
            </header>

            <Tabs tabs={tabs} activeId={tab} onSelect={(id) => setTab(id as TabId)}>
                {tab === "overview" && (
                    <OverviewPanel project={project} tasks={tasks} members={members} />
                )}
                {tab === "tasks" && (
                    <TaskListPanel
                        project={project}
                        tasks={tasks}
                        members={members}
                        onCreated={refreshTasksAndActivity}
                        onActivityChanged={refreshTasksAndActivity}
                        onStatusChange={handleStatusChange}
                        onDelete={handleDelete}
                    />
                )}
                {tab === "members" && (
                    <MembersPanel
                        project={project}
                        members={members}
                        onChanged={refreshMembersAndActivity}
                    />
                )}
                {tab === "activity" && <ActivityPanel entries={activity} members={members} />}
            </Tabs>

            <ConfirmDialog
                open={confirmArchive}
                title="Archive this project?"
                message={`Archived projects are read-only. You can still browse "${project.name}" but no further changes can be made.`}
                confirmLabel="Archive"
                danger
                onConfirm={handleArchive}
                onCancel={() => setConfirmArchive(false)}
            />
        </div>
    );
}

export type { TabId };
export { Avatar };
