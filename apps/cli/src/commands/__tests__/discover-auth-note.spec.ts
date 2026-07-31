/**
 * Auth-pause screen expiry note.
 *
 * When a saved auth storage state was loaded for the run but the site still
 * redirected to the login wall, the pause screen used to be identical to the
 * no-session case — leaving users to guess that their stored session had
 * expired. The screen now points that out explicitly and tells them to
 * refresh with `raiken auth`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildForegroundUx } from "../discover";

function makeSpinner() {
    return {
        text: "",
        stop: vi.fn(),
        fail: vi.fn(),
        isSpinning: false,
    } as never;
}

function authBlockedEvent(url: string) {
    return {
        type: "auth_blocked",
        data: {
            blocker: { url, category: "auth_required", blockerType: "login_redirect" },
        },
        timestamp: 0,
    } as never;
}

describe("discover auth pause expiry note", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    afterEach(() => {
        logSpy.mockClear();
    });

    function renderPause(hadAuthState: boolean, pauseOnAuth = true): string {
        const { ux, progressInterval } = buildForegroundUx({
            projectPath: "/tmp/irrelevant",
            spinner: makeSpinner(),
            maxPages: 10,
            maxDepth: 5,
            pauseOnAuth,
            showAuthOptions: true,
            authHeader: "Authentication required",
            authHint: "Discovery paused.",
            hadAuthState,
        });
        clearInterval(progressInterval);
        ux.onAuthBlocked?.(authBlockedEvent("http://app.local/login") as never);
        return logSpy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
    }

    it("points out the loaded session may have expired when auth state was used", () => {
        const output = renderPause(true);
        expect(output).toContain("may have expired");
        expect(output).toContain("raiken auth");
    });

    it("omits the expiry note when no auth state was loaded", () => {
        const output = renderPause(false);
        expect(output).toContain("Authentication required");
        expect(output).not.toContain("may have expired");
    });

    it("stays quiet in --skip-auth mode even with auth state loaded", () => {
        const output = renderPause(true, false);
        expect(output).toContain("Skipping protected route");
        expect(output).not.toContain("may have expired");
    });
});
