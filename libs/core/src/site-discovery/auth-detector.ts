/**
 * Authentication Detector (back-compat shim).
 *
 * The implementation moved to `detectors/auth.ts` as part of the generic
 * blocker pipeline. This file keeps the old `AuthDetector` class export
 * so external imports (and the existing crawler call site) keep
 * compiling. Internally it delegates to `detectAuth`, which is the new
 * framework's source of truth.
 */

import type { Page, Response } from "playwright";

import { detectAuth } from "./detectors/auth";
import type { AuthBlocker } from "./types";

export class AuthDetector {
    private projectPath: string;

    constructor(projectPath: string) {
        this.projectPath = projectPath;
    }

    async detect(
        page: Page,
        url: string,
        response?: Response,
    ): Promise<AuthBlocker | null> {
        return detectAuth({
            projectPath: this.projectPath,
            page,
            url,
            response,
        });
    }
}
