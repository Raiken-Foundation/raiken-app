import type {
    ActivityEntry,
    Comment,
    Project,
    ProjectStats,
    Task,
    TaskPriority,
    TaskStatus,
    User,
} from "../types";

/**
 * Deterministic seed data for the Orbit project suite. Every timestamp is a
 * fixed string relative to the same anchor date so rendered dates, "overdue"
 * logic, and activity feeds never shift between runs.
 */
const T = (offsetDays: number, hour = 9): string => {
    const anchor = Date.parse("2026-04-01T00:00:00.000Z");
    return new Date(anchor + offsetDays * 86_400_000 + hour * 3_600_000).toISOString();
};

export const USERS: User[] = [
    {
        id: "u-admin",
        username: "admin",
        displayName: "Ada Admin",
        role: "admin",
        email: "ada@orbit.example",
        joinedAt: T(-120),
    },
    {
        id: "u-priya",
        username: "priya",
        displayName: "Priya Patel",
        role: "member",
        email: "priya@orbit.example",
        joinedAt: T(-90),
    },
    {
        id: "u-jamal",
        username: "jamal",
        displayName: "Jamal Carter",
        role: "member",
        email: "jamal@orbit.example",
        joinedAt: T(-60),
    },
    {
        id: "u-tessa",
        username: "tessa",
        displayName: "Tessa Nguyen",
        role: "member",
        email: "tessa@orbit.example",
        joinedAt: T(-30),
    },
    {
        id: "u-kai",
        username: "kai",
        displayName: "Kai Tanaka",
        role: "viewer",
        email: "kai@orbit.example",
        joinedAt: T(-14),
    },
];

export const PROJECTS: Project[] = [
    {
        id: "p-atlas",
        slug: "atlas",
        name: "Atlas",
        description: "Customer data warehouse migration",
        status: "active",
        ownerId: "u-priya",
        teamIds: ["u-priya", "u-jamal", "u-tessa", "u-kai"],
        createdAt: T(-45),
        updatedAt: T(-1),
    },
    {
        id: "p-orion",
        slug: "orion",
        name: "Orion",
        description: "Realtime collaboration features",
        status: "active",
        ownerId: "u-jamal",
        teamIds: ["u-jamal", "u-tessa", "u-kai"],
        createdAt: T(-38),
        updatedAt: T(-2),
    },
    {
        id: "p-quasar",
        slug: "quasar",
        name: "Quasar",
        description: "Mobile app redesign",
        status: "completed",
        ownerId: "u-tessa",
        teamIds: ["u-tessa", "u-priya"],
        createdAt: T(-75),
        updatedAt: T(-20),
    },
    {
        id: "p-helio",
        slug: "helio",
        name: "Helio",
        description: "Developer platform API v2",
        status: "active",
        ownerId: "u-admin",
        teamIds: ["u-admin", "u-jamal"],
        createdAt: T(-25),
        updatedAt: T(-1),
    },
    {
        id: "p-nova",
        slug: "nova",
        name: "Nova",
        description: "Design system consolidation",
        status: "archived",
        ownerId: "u-tessa",
        teamIds: ["u-tessa"],
        createdAt: T(-100),
        updatedAt: T(-60),
    },
    {
        id: "p-kepler",
        slug: "kepler",
        name: "Kepler",
        description: "Billing and invoicing overhaul",
        status: "active",
        ownerId: "u-priya",
        teamIds: ["u-priya", "u-tessa", "u-kai"],
        createdAt: T(-12),
        updatedAt: T(-1),
    },
    {
        id: "p-pulsar",
        slug: "pulsar",
        name: "Pulsar",
        description: "Event ingestion pipeline",
        status: "active",
        ownerId: "u-admin",
        teamIds: ["u-admin", "u-jamal", "u-tessa"],
        createdAt: T(-8),
        updatedAt: T(0),
    },
    {
        id: "p-lyra",
        slug: "lyra",
        name: "Lyra",
        description: "Accessibility audit remediation",
        status: "active",
        ownerId: "u-kai",
        teamIds: ["u-kai", "u-tessa"],
        createdAt: T(-5),
        updatedAt: T(-1),
    },
    {
        id: "p-vega",
        slug: "vega",
        name: "Vega",
        description: "Dark mode and theming",
        status: "active",
        ownerId: "u-jamal",
        teamIds: ["u-jamal", "u-tessa"],
        createdAt: T(-3),
        updatedAt: T(0),
    },
    {
        id: "p-callisto",
        slug: "callisto",
        name: "Callisto",
        description: "SSO integration pilot",
        status: "completed",
        ownerId: "u-admin",
        teamIds: ["u-admin", "u-priya"],
        createdAt: T(-90),
        updatedAt: T(-15),
    },
    {
        id: "p-vesta",
        slug: "vesta",
        name: "Vesta",
        description: "Search indexing improvements",
        status: "active",
        ownerId: "u-priya",
        teamIds: ["u-priya", "u-jamal"],
        createdAt: T(-2),
        updatedAt: T(0),
    },
    {
        id: "p-europa",
        slug: "europa",
        name: "Europa",
        description: "Onboarding flow redesign",
        status: "active",
        ownerId: "u-tessa",
        teamIds: ["u-tessa", "u-kai", "u-priya"],
        createdAt: T(-1),
        updatedAt: T(0),
    },
];

export interface SeedTask {
    id: string;
    projectId: string;
    title: string;
    description: string;
    status: TaskStatus;
    priority: TaskPriority;
    assigneeId: string | null;
    createdOffsetDays: number;
    updatedOffsetDays: number;
}

export const TASKS: SeedTask[] = [
    // Atlas
    { id: "t-atlas-1", projectId: "p-atlas", title: "Backfill customer records", description: "Migrate legacy CRM rows into the warehouse.", status: "done", priority: "high", assigneeId: "u-jamal", createdOffsetDays: -44, updatedOffsetDays: -3 },
    { id: "t-atlas-2", projectId: "p-atlas", title: "Schema validation for incoming batches", description: "Reject malformed rows before load.", status: "in_progress", priority: "high", assigneeId: "u-priya", createdOffsetDays: -30, updatedOffsetDays: -1 },
    { id: "t-atlas-3", projectId: "p-atlas", title: "Redact PII in exports", description: "Columns flagged personal must be masked.", status: "todo", priority: "urgent", assigneeId: "u-tessa", createdOffsetDays: -6, updatedOffsetDays: -6 },
    { id: "t-atlas-4", projectId: "p-atlas", title: "Document the loader contract", description: "Write the ADR for the ingestion format.", status: "todo", priority: "low", assigneeId: null, createdOffsetDays: -4, updatedOffsetDays: -4 },
    // Orion
    { id: "t-orion-1", projectId: "p-orion", title: "Presence indicators on task cards", description: "Show who is viewing a task in real time.", status: "in_progress", priority: "medium", assigneeId: "u-jamal", createdOffsetDays: -20, updatedOffsetDays: -2 },
    { id: "t-orion-2", projectId: "p-orion", title: "Comment threads with mentions", description: "Notify @mentioned members by toast.", status: "todo", priority: "high", assigneeId: "u-tessa", createdOffsetDays: -10, updatedOffsetDays: -10 },
    { id: "t-orion-3", projectId: "p-orion", title: "Offline draft queue", description: "Keep edits local and sync on reconnect.", status: "review", priority: "medium", assigneeId: "u-kai", createdOffsetDays: -15, updatedOffsetDays: -1 },
    // Quasar (completed)
    { id: "t-quasar-1", projectId: "p-quasar", title: "Component inventory", description: "Audit every screen for reused primitives.", status: "done", priority: "medium", assigneeId: "u-tessa", createdOffsetDays: -74, updatedOffsetDays: -25 },
    { id: "t-quasar-2", projectId: "p-quasar", title: "Motion guidelines", description: "Define duration and easing tokens.", status: "done", priority: "low", assigneeId: "u-priya", createdOffsetDays: -60, updatedOffsetDays: -22 },
    // Helio
    { id: "t-helio-1", projectId: "p-helio", title: "OAuth2 client credentials flow", description: "Server-to-server tokens for the platform API.", status: "in_progress", priority: "urgent", assigneeId: "u-jamal", createdOffsetDays: -14, updatedOffsetDays: -1 },
    { id: "t-helio-2", projectId: "p-helio", title: "Rate limit headers", description: "Expose X-RateLimit-* on every response.", status: "todo", priority: "high", assigneeId: "u-admin", createdOffsetDays: -9, updatedOffsetDays: -9 },
    // Kepler
    { id: "t-kepler-1", projectId: "p-kepler", title: "Invoice PDF templates", description: "Two layouts: summary and detailed.", status: "in_progress", priority: "high", assigneeId: "u-priya", createdOffsetDays: -8, updatedOffsetDays: -1 },
    { id: "t-kepler-2", projectId: "p-kepler", title: "Payment retry scheduling", description: "Backoff strategy for failed charges.", status: "todo", priority: "medium", assigneeId: "u-tessa", createdOffsetDays: -4, updatedOffsetDays: -4 },
    // Pulsar
    { id: "t-pulsar-1", projectId: "p-pulsar", title: "Kafka topic partitioning", description: "Choose the partition key strategy.", status: "todo", priority: "urgent", assigneeId: "u-jamal", createdOffsetDays: -2, updatedOffsetDays: -2 },
    { id: "t-pulsar-2", projectId: "p-pulsar", title: "Dead-letter queue consumer", description: "Retry poison messages with backoff.", status: "in_progress", priority: "high", assigneeId: "u-tessa", createdOffsetDays: -6, updatedOffsetDays: 0 },
    // Lyra
    { id: "t-lyra-1", projectId: "p-lyra", title: "Fix focus traps in modals", description: "Keyboard users must not tab into the backdrop.", status: "todo", priority: "high", assigneeId: "u-kai", createdOffsetDays: -4, updatedOffsetDays: -4 },
    { id: "t-lyra-2", projectId: "p-lyra", title: "Contrast audit on status pills", description: "AA on all pill/text pairs.", status: "review", priority: "medium", assigneeId: "u-tessa", createdOffsetDays: -3, updatedOffsetDays: -1 },
    // Vega
    { id: "t-vega-1", projectId: "p-vega", title: "Dark palette tokens", description: "Define the semantic color ramp.", status: "todo", priority: "medium", assigneeId: "u-jamal", createdOffsetDays: -2, updatedOffsetDays: -2 },
    // Callisto (completed)
    { id: "t-callisto-1", projectId: "p-callisto", title: "SAML metadata import", description: "Parse IdP metadata at setup time.", status: "done", priority: "high", assigneeId: "u-admin", createdOffsetDays: -88, updatedOffsetDays: -16 },
    // Vesta
    { id: "t-vesta-1", projectId: "p-vesta", title: "Index debounce strategy", description: "Batch writes to the search index.", status: "todo", priority: "medium", assigneeId: "u-priya", createdOffsetDays: -1, updatedOffsetDays: -1 },
    // Europa
    { id: "t-europa-1", projectId: "p-europa", title: "Welcome checklist", description: "Five steps new users complete.", status: "in_progress", priority: "high", assigneeId: "u-tessa", createdOffsetDays: -1, updatedOffsetDays: 0 },
    { id: "t-europa-2", projectId: "p-europa", title: "Tooltip tour on first login", description: "Highlight the three key surfaces.", status: "todo", priority: "low", assigneeId: "u-kai", createdOffsetDays: 0, updatedOffsetDays: 0 },
];

export const COMMENTS: Comment[] = [
    { id: "c-atlas-2-1", taskId: "t-atlas-2", authorId: "u-priya", body: "Validation now rejects rows missing the tenant id.", createdAt: T(-2) },
    { id: "c-atlas-2-2", taskId: "t-atlas-2", authorId: "u-jamal", body: "Add a quota limit per batch before we ship.", createdAt: T(-1) },
    { id: "c-orion-3-1", taskId: "t-orion-3", authorId: "u-kai", body: "Draft queue is up for review — see the linked PR.", createdAt: T(-1) },
    { id: "c-helio-1-1", taskId: "t-helio-1", authorId: "u-admin", body: "Scope the token lifetime to 15 minutes.", createdAt: T(-2) },
    { id: "c-kepler-1-1", taskId: "t-kepler-1", authorId: "u-priya", body: "Summary layout approved by finance.", createdAt: T(-1) },
];

export const ACTIVITY: ActivityEntry[] = [
    { id: "a-1", actorId: "u-tessa", projectId: "p-pulsar", message: "moved Pulsar / Dead-letter queue consumer to In progress", createdAt: T(0, 10) },
    { id: "a-2", actorId: "u-priya", projectId: "p-atlas", message: "updated the priority of Atlas / Schema validation to High", createdAt: T(0, 9) },
    { id: "a-3", actorId: "u-jamal", projectId: "p-helio", message: "created task Helio / Rate limit headers", createdAt: T(-1, 16) },
    { id: "a-4", actorId: "u-kai", projectId: "p-orion", message: "commented on Orion / Offline draft queue", createdAt: T(-1, 15) },
    { id: "a-5", actorId: "u-admin", projectId: "p-kepler", message: "archived project Nova", createdAt: T(-2, 11) },
    { id: "a-6", actorId: "u-tessa", projectId: "p-lyra", message: "created project Lyra", createdAt: T(-5, 14) },
    { id: "a-7", actorId: "u-priya", projectId: "p-kepler", message: "commented on Kepler / Invoice PDF templates", createdAt: T(-1, 12) },
    { id: "a-8", actorId: "u-jamal", projectId: "p-orion", message: "moved Orion / Presence indicators to In progress", createdAt: T(-2, 9) },
    { id: "a-9", actorId: "u-tessa", projectId: "p-quasar", message: "completed task Quasar / Component inventory", createdAt: T(-25, 10) },
    { id: "a-10", actorId: "u-kai", projectId: null, message: "joined the workspace as viewer", createdAt: T(-14, 9) },
    { id: "a-11", actorId: "u-admin", projectId: null, message: "invited Tessa Nguyen to the workspace", createdAt: T(-30, 9) },
];

/** Auth: every seeded account uses the same password; the demo login form says so. */
export const SEED_PASSWORD = "password";

const ANCHOR_MS = Date.parse("2026-04-01T00:00:00.000Z");

export function computeStats(projects: Project[], tasks: Task[]): ProjectStats {
    const activeProjects = projects.filter((p) => p.status === "active").length;
    const openTasks = tasks.filter((t) => t.status !== "done").length;
    const staleCutoff = ANCHOR_MS - 3 * 86_400_000;
    const overdueTasks = tasks.filter(
        (t) => t.status !== "done" && Date.parse(t.updatedAt) < staleCutoff,
    ).length;
    return { projects: projects.length, activeProjects, openTasks, overdueTasks };
}
