import type { ReportErrorLocation } from "./playwright-report-model";

/** Narrow structural views of the (untyped) Playwright reporter JSON. */
export interface PlaywrightJsonResult {
    status?: string;
    duration?: number;
    error?: { message?: string; stack?: string; snippet?: string; location?: ReportErrorLocation };
    attachments?: Array<{ name?: string; contentType?: string; path?: string; body?: string }>;
}
export interface PlaywrightJsonSpec {
    id?: string;
    title: string;
    /** Path relative to reporter config.rootDir (present on --list and run reports). */
    file?: string;
    line?: number;
    tests?: Array<{ projectName?: string; projectId?: string; results?: PlaywrightJsonResult[] }>;
}
export interface PlaywrightJsonSuite {
    title?: string;
    specs?: PlaywrightJsonSpec[];
    suites?: PlaywrightJsonSuite[];
}
export interface PlaywrightJsonReport {
    config?: { rootDir?: string };
    stats?: { expected?: number; unexpected?: number; skipped?: number; duration?: number };
    suites?: PlaywrightJsonSuite[];
    errors?: Array<{ message?: string; snippet?: string; location?: ReportErrorLocation }>;
}

export interface WalkedPlaywrightSpec {
    suitePath: string;
    spec: PlaywrightJsonSpec;
}
