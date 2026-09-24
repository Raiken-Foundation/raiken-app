/**
 * Navigation route types for the dashboard views.
 *
 * The slash-command registry that used to live here was the chat composer's
 * command engine; it was removed together with the chat surface. Navigation
 * is the nav rail and hash routes (#/contract, #/quality/doctor, ...).
 */

export type DashboardView = "testing" | "quality" | "contract";

/** A sub-route inside a view (e.g. `quality/doctor`). */
export type DashboardRoute =
    | { view: "testing" }
    | { view: "quality"; tool?: "doctor" | "impact" | "trace" | "cover" | "context" }
    | { view: "contract" };
