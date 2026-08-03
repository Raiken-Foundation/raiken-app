import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import * as api from "../api";
import type { Project, ProjectTaskCounts } from "../types";
import { SearchInput } from "../components/SearchInput";
import { ProjectStatusPill } from "../components/StatusPill";
import { Pagination } from "../components/Pagination";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { Modal } from "../components/Modal";
import { FormField } from "../components/FormField";
import { useToast } from "../contexts/ToastContext";
import { useAuth } from "../contexts/AuthContext";

const PAGE_SIZE = 5;

type StatusFilter = "all" | Project["status"];

export function ProjectsListPage() {
    const { can, user } = useAuth();
    const { push } = useToast();
    const [projects, setProjects] = useState<Project[] | null>(null);
    const [counts, setCounts] = useState<Record<string, ProjectTaskCounts> | null>(null);
    const [query, setQuery] = useState("");
    const [status, setStatus] = useState<StatusFilter>("all");
    const [page, setPage] = useState(1);
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [formError, setFormError] = useState<string | null>(null);

    const reload = useCallback(async () => {
        const [all, taskCounts] = await Promise.all([
            api.listProjects(),
            api.taskCountsByProject(),
        ]);
        setProjects(all);
        setCounts(taskCounts);
    }, []);

    useEffect(() => {
        void reload();
    }, [reload]);

    useEffect(() => {
        setPage(1);
    }, [query, status]);

    const filtered = useMemo(() => {
        if (!projects) return [];
        let next = projects;
        const q = query.trim().toLowerCase();
        if (q) {
            next = next.filter(
                (p) =>
                    p.name.toLowerCase().includes(q) ||
                    p.description.toLowerCase().includes(q),
            );
        }
        if (status !== "all") next = next.filter((p) => p.status === status);
        return [...next].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }, [projects, query, status]);

    const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

    const handleCreate = async () => {
        setFormError(null);
        if (!name.trim()) {
            setFormError("Project name is required.");
            return;
        }
        if (name.trim().length < 3) {
            setFormError("Project name must be at least 3 characters.");
            return;
        }
        try {
            await api.createProject({
                name: name.trim(),
                description: description.trim(),
                actor: user!,
            });
            push("success", `Created project ${name.trim()}`);
            setCreating(false);
            setName("");
            setDescription("");
            await reload();
        } catch (err) {
            setFormError(err instanceof Error ? err.message : "Could not create the project.");
        }
    };

    return (
        <main className="page" data-testid="projects-page">
            <header className="page-header">
                <h1>Projects</h1>
                {can("manage") ? (
                    <button
                        type="button"
                        className="button button-primary"
                        data-testid="create-project"
                        onClick={() => setCreating(true)}
                    >
                        New project
                    </button>
                ) : null}
            </header>

            <div className="toolbar">
                <SearchInput
                    value={query}
                    onChange={setQuery}
                    placeholder="Search projects…"
                    aria-label="Search projects"
                    data-testid="projects-search"
                />
                <div className="segmented" role="group" aria-label="Filter by status">
                    {(["all", "active", "completed", "archived"] as StatusFilter[]).map(
                        (value) => (
                            <button
                                key={value}
                                type="button"
                                className={`segment ${status === value ? "segment-active" : ""}`}
                                data-testid={`filter-${value}`}
                                onClick={() => setStatus(value)}
                            >
                                {value === "all" ? "All" : value[0]!.toUpperCase() + value.slice(1)}
                            </button>
                        ),
                    )}
                </div>
            </div>

            {projects === null || counts === null ? (
                <Skeleton lines={5} />
            ) : pageItems.length === 0 ? (
                <EmptyState
                    title="No projects match"
                    hint={query ? `Nothing matches "${query}".` : "Try another filter."}
                    action={
                        query || status !== "all" ? (
                            <button
                                type="button"
                                className="button button-ghost"
                                data-testid="clear-filters"
                                onClick={() => {
                                    setQuery("");
                                    setStatus("all");
                                }}
                            >
                                Clear filters
                            </button>
                        ) : undefined
                    }
                />
            ) : (
                <div className="project-grid" data-testid="project-grid">
                    {pageItems.map((project) => {
                        const taskCounts = counts[project.id];
                        const total = taskCounts
                            ? taskCounts.todo +
                              taskCounts.in_progress +
                              taskCounts.review +
                              taskCounts.done
                            : 0;
                        return (
                            <Link
                                key={project.id}
                                to={`/projects/${project.slug}`}
                                className="card project-card"
                                data-testid={`project-${project.slug}`}
                            >
                                <header className="project-card-header">
                                    <h3>{project.name}</h3>
                                    <ProjectStatusPill status={project.status} />
                                </header>
                                <p className="muted project-card-description">
                                    {project.description}
                                </p>
                                <footer className="project-card-footer">
                                    {taskCounts ? (
                                        <span className="muted" data-testid={`tasks-${project.slug}`}>
                                            {total} task{total === 1 ? "" : "s"}
                                        </span>
                                    ) : null}
                                    <span className="muted">{project.teamIds.length} member(s)</span>
                                </footer>
                            </Link>
                        );
                    })}
                </div>
            )}

            <Pagination page={page} pageCount={pageCount} onChange={setPage} />

            {creating ? (
                <Modal
                    title="New project"
                    onClose={() => setCreating(false)}
                    footer={
                        <>
                            <button
                                type="button"
                                className="button button-ghost"
                                onClick={() => setCreating(false)}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="button button-primary"
                                data-testid="create-project-submit"
                                onClick={handleCreate}
                            >
                                Create project
                            </button>
                        </>
                    }
                >
                    <form
                        onSubmit={(event) => {
                            event.preventDefault();
                            void handleCreate();
                        }}
                    >
                        <FormField
                            label="Project name"
                            htmlFor="project-name-input"
                            error={formError}
                        >
                            <input
                                id="project-name-input"
                                className="input"
                                type="text"
                                value={name}
                                data-testid="project-name-input"
                                onChange={(event) => setName(event.target.value)}
                            />
                        </FormField>
                        <FormField label="Description" htmlFor="project-description-input">
                            <textarea
                                id="project-description-input"
                                className="input"
                                rows={3}
                                value={description}
                                data-testid="project-description-input"
                                onChange={(event) => setDescription(event.target.value)}
                            />
                        </FormField>
                    </form>
                </Modal>
            ) : null}
        </main>
    );
}
