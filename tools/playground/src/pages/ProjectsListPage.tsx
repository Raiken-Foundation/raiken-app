import { useEffect, useId, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, createProject, listProjects } from "../api";
import Modal from "../components/Modal";
import Pagination from "../components/Pagination";
import { ProjectStatusPill } from "../components/StatusPill";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import type { Project, ProjectStatus } from "../types";

type SortKey = "name" | "updated" | "status";
type Direction = "asc" | "desc";

const PAGE_SIZE = 4;

export default function ProjectsListPage() {
    const { user, isAdmin } = useAuth();
    const { push } = useToast();

    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState<ProjectStatus | "all">("all");
    const [sort, setSort] = useState<SortKey>("updated");
    const [direction, setDirection] = useState<Direction>("desc");
    const [page, setPage] = useState(1);

    const [items, setItems] = useState<Project[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [reloadToken, setReloadToken] = useState(0);

    const [showCreate, setShowCreate] = useState(false);

    useEffect(() => {
        let cancelled = false;
        async function load() {
            setLoading(true);
            setError(null);
            try {
                const result = await listProjects({
                    search,
                    status: statusFilter,
                    sort,
                    direction,
                    page,
                    pageSize: PAGE_SIZE,
                });
                if (cancelled) return;
                setItems(result.items);
                setTotal(result.total);
            } catch (err) {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : "Failed to load projects");
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        }
        load();
        return () => {
            cancelled = true;
        };
    }, [search, statusFilter, sort, direction, page, reloadToken]);

    const toggleSort = (key: SortKey) => {
        if (sort === key) {
            setDirection((d) => (d === "asc" ? "desc" : "asc"));
        } else {
            setSort(key);
            setDirection("asc");
        }
        setPage(1);
    };

    const indicator = (key: SortKey) => (sort !== key ? "" : direction === "asc" ? " ▲" : " ▼");

    const reload = () => {
        setPage(1);
        setReloadToken((t) => t + 1);
    };

    return (
        <div className="page" data-testid="projects-page">
            <header className="page-header">
                <div>
                    <h1>Projects</h1>
                    <p className="page-subtitle">Browse, filter and create projects.</p>
                </div>
                {isAdmin && (
                    <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => setShowCreate(true)}
                        data-testid="open-create-project"
                    >
                        + New project
                    </button>
                )}
            </header>

            <ProjectsToolbar
                search={search}
                onSearchChange={(v) => {
                    setSearch(v);
                    setPage(1);
                }}
                statusFilter={statusFilter}
                onStatusChange={(v) => {
                    setStatusFilter(v);
                    setPage(1);
                }}
            />

            {error && (
                <div className="alert alert-error" role="alert" data-testid="projects-error">
                    {error}
                </div>
            )}

            <div className="table-wrapper">
                <table className="data-table" data-testid="projects-table">
                    <thead>
                        <tr>
                            <th>
                                <button
                                    type="button"
                                    className="table-sort"
                                    onClick={() => toggleSort("name")}
                                    data-testid="sort-name"
                                >
                                    Name{indicator("name")}
                                </button>
                            </th>
                            <th>
                                <button
                                    type="button"
                                    className="table-sort"
                                    onClick={() => toggleSort("status")}
                                    data-testid="sort-status"
                                >
                                    Status{indicator("status")}
                                </button>
                            </th>
                            <th>Members</th>
                            <th>
                                <button
                                    type="button"
                                    className="table-sort"
                                    onClick={() => toggleSort("updated")}
                                    data-testid="sort-updated"
                                >
                                    Updated{indicator("updated")}
                                </button>
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {loading && (
                            <tr>
                                <td
                                    colSpan={4}
                                    className="table-empty"
                                    data-testid="projects-loading"
                                >
                                    Loading projects…
                                </td>
                            </tr>
                        )}
                        {!loading && items.length === 0 && (
                            <tr>
                                <td
                                    colSpan={4}
                                    className="table-empty"
                                    data-testid="projects-empty"
                                >
                                    No projects matched your filters.
                                </td>
                            </tr>
                        )}
                        {!loading && items.map((p) => <ProjectRow key={p.id} project={p} />)}
                    </tbody>
                </table>
            </div>

            <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />

            {showCreate && user && (
                <CreateProjectModal
                    onClose={() => setShowCreate(false)}
                    onCreated={(project) => {
                        push("success", `Created "${project.name}"`);
                        setShowCreate(false);
                        reload();
                    }}
                />
            )}
        </div>
    );
}

function ProjectsToolbar({
    search,
    onSearchChange,
    statusFilter,
    onStatusChange,
}: {
    search: string;
    onSearchChange: (v: string) => void;
    statusFilter: ProjectStatus | "all";
    onStatusChange: (v: ProjectStatus | "all") => void;
}) {
    const searchId = useId();
    const statusId = useId();
    return (
        <div className="toolbar" data-testid="projects-toolbar">
            <div className="toolbar-field">
                <label htmlFor={searchId}>Search</label>
                <input
                    id={searchId}
                    type="search"
                    value={search}
                    placeholder="Project name or description"
                    onChange={(e) => onSearchChange(e.target.value)}
                    data-testid="projects-search"
                />
            </div>
            <div className="toolbar-field">
                <label htmlFor={statusId}>Status</label>
                <select
                    id={statusId}
                    value={statusFilter}
                    onChange={(e) => onStatusChange(e.target.value as ProjectStatus | "all")}
                    data-testid="projects-status-filter"
                >
                    <option value="all">All</option>
                    <option value="active">Active</option>
                    <option value="on_hold">On hold</option>
                    <option value="archived">Archived</option>
                </select>
            </div>
        </div>
    );
}

function ProjectRow({ project }: { project: Project }) {
    return (
        <tr data-testid={`project-row-${project.slug}`}>
            <td>
                <Link
                    to={`/projects/${project.slug}`}
                    className="link"
                    data-testid={`project-link-${project.slug}`}
                >
                    {project.name}
                </Link>
                <div className="row-subtitle">{project.description}</div>
            </td>
            <td>
                <ProjectStatusPill status={project.status} />
            </td>
            <td data-testid={`project-members-${project.slug}`}>{project.memberIds.length}</td>
            <td className="row-muted">{new Date(project.updatedAt).toLocaleDateString()}</td>
        </tr>
    );
}

function CreateProjectModal({
    onClose,
    onCreated,
}: {
    onClose: () => void;
    onCreated: (project: Project) => void;
}) {
    const { user } = useAuth();
    const { push } = useToast();
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const nameId = useId();
    const descId = useId();

    const canSubmit = useMemo(() => name.trim().length >= 3, [name]);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!user) return;
        setSubmitting(true);
        setError(null);
        try {
            const project = await createProject({
                name,
                description,
                actor: user,
            });
            onCreated(project);
        } catch (err) {
            const message = err instanceof ApiError ? err.message : "Failed to create project";
            setError(message);
            push("error", message);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal
            open
            title="New project"
            onClose={onClose}
            testId="create-project-modal"
            footer={
                <>
                    <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={onClose}
                        data-testid="create-project-cancel"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        form="create-project-form"
                        className="btn btn-primary"
                        disabled={!canSubmit || submitting}
                        data-testid="create-project-submit"
                    >
                        {submitting ? "Creating…" : "Create project"}
                    </button>
                </>
            }
        >
            <form id="create-project-form" className="modal-form" onSubmit={submit}>
                <div className="form-group">
                    <label htmlFor={nameId}>Name</label>
                    <input
                        id={nameId}
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        minLength={3}
                        required
                        data-testid="create-project-name"
                    />
                </div>
                <div className="form-group">
                    <label htmlFor={descId}>Description</label>
                    <textarea
                        id={descId}
                        rows={3}
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        data-testid="create-project-description"
                    />
                </div>
                {error && (
                    <div className="form-error" role="alert" data-testid="create-project-error">
                        {error}
                    </div>
                )}
            </form>
        </Modal>
    );
}
