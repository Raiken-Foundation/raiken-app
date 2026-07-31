import { correlationFields, ensureCorrelationId } from "./context";
import { redactString, redactValue } from "./redaction";
import type {
    ObservabilityConfig,
    ObservabilityEvent,
    ObservabilityLevel,
    ObservabilitySink,
} from "./types";

const LEVEL_RANK: Record<ObservabilityLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

let activeSink: ObservabilitySink | null = null;
let config: ObservabilityConfig = loadConfigFromEnv();

function loadConfigFromEnv(): ObservabilityConfig {
    const jsonFlag = process.env["RAIKEN_LOG_JSON"];
    const jsonLogging = jsonFlag === "1" || jsonFlag?.toLowerCase() === "true";
    // Default "error": lifecycle events (test.run.started/completed cid=…)
    // duplicate what the CLI already prints in human mode, even at warn. The
    // stream stays available for diagnosis via RAIKEN_LOG_LEVEL=warn|info|debug.
    const levelRaw = (process.env["RAIKEN_LOG_LEVEL"] ?? "error").toLowerCase();
    const minLevel = (["debug", "info", "warn", "error"] as const).includes(
        levelRaw as ObservabilityLevel,
    )
        ? (levelRaw as ObservabilityLevel)
        : "error";
    return { jsonLogging, minLevel };
}

/** Override observability config (tests). */
export function configureObservability(partial: Partial<ObservabilityConfig>): void {
    config = { ...config, ...partial };
}

/** Inject a custom sink; pass null to restore default console behavior. */
export function setObservabilitySink(sink: ObservabilitySink | null): void {
    activeSink = sink;
}

function shouldEmit(level: ObservabilityLevel): boolean {
    return LEVEL_RANK[level] >= LEVEL_RANK[config.minLevel];
}

function formatHuman(event: ObservabilityEvent): string {
    const parts = [`[${event.level}]`, event.event];
    if (event.durationMs !== undefined) parts.push(`${event.durationMs}ms`);
    if (event.status !== undefined) parts.push(String(event.status));
    if (event.correlationId) parts.push(`cid=${event.correlationId}`);
    if (event.operationId) parts.push(`op=${event.operationId}`);
    if (event.runId) parts.push(`run=${event.runId}`);
    const head = parts.join(" ");
    return event.message ? `${head} — ${event.message}` : head;
}

function defaultSink(event: ObservabilityEvent): void {
    if (config.jsonLogging) {
        process.stderr.write(`${JSON.stringify(event)}\n`);
        return;
    }
    const line = formatHuman(event);
    switch (event.level) {
        case "error":
            console.error(line);
            break;
        case "warn":
            console.warn(line);
            break;
        case "debug":
            console.debug(line);
            break;
        default:
            console.log(line);
    }
}

/** Emit a structured observability event with correlation context and redaction. */
export function emitObservabilityEvent(
    input: Omit<ObservabilityEvent, "at" | keyof ReturnType<typeof correlationFields>> &
        Partial<
            Pick<
                ObservabilityEvent,
                | "correlationId"
                | "operationId"
                | "workflowId"
                | "discoverySessionId"
                | "runId"
                | "projectRef"
                | "requestId"
            >
        >,
): void {
    if (!shouldEmit(input.level)) return;

    ensureCorrelationId();
    const event: ObservabilityEvent = {
        ...correlationFields(),
        ...input,
        at: Date.now(),
        message: input.message ? redactString(input.message) : undefined,
        meta: input.meta ? (redactValue(input.meta) as Record<string, unknown>) : undefined,
    };

    (activeSink ?? defaultSink)(event);
}

/** Convenience helpers. */
export const obs = {
    debug: (event: string, fields?: Partial<ObservabilityEvent>) =>
        emitObservabilityEvent({ level: "debug", event, ...fields }),
    info: (event: string, fields?: Partial<ObservabilityEvent>) =>
        emitObservabilityEvent({ level: "info", event, ...fields }),
    warn: (event: string, fields?: Partial<ObservabilityEvent>) =>
        emitObservabilityEvent({ level: "warn", event, ...fields }),
    error: (event: string, fields?: Partial<ObservabilityEvent>) =>
        emitObservabilityEvent({ level: "error", event, ...fields }),
    duration: (event: string, startedAt: number, fields?: Partial<ObservabilityEvent>) =>
        emitObservabilityEvent({
            level: fields?.level ?? "info",
            event,
            durationMs: Date.now() - startedAt,
            ...fields,
        }),
};

/** Reset config/sink for tests. */
export function resetObservabilityForTests(): void {
    activeSink = null;
    config = loadConfigFromEnv();
}

export { loadConfigFromEnv as readObservabilityConfigFromEnv };
