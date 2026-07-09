/**
 * Site Knowledge Loader
 *
 * Loads discovered site knowledge from database and formats it for agent context.
 */

import { CodeGraphDB } from "../database/db";
import { SiteKnowledgeDB } from "./db";
import type {
    DiscoveredRoute,
    NavigationPath,
    PageForms,
    SelectorHint,
    SiteKnowledge,
} from "./types";

/** Cap the route catalog so a large crawl can't blow the prompt budget. */
const MAX_ROUTES = 60;
/** Cap form fields rendered per page so a huge form can't dominate the prompt. */
const MAX_FIELDS_PER_PAGE = 12;

/**
 * Strip the origin from a URL when it matches the project's configured
 * `baseURL`, so discovery knowledge matches the prompt's own rule ("URLs
 * MUST be relative paths" once a baseURL is set). Left unchanged for
 * cross-origin URLs (e.g. an OAuth provider) or when no baseURL is known.
 */
function toDisplayUrl(url: string, baseURL?: string | null): string {
    if (!baseURL) return url;
    try {
        const target = new URL(url);
        const base = new URL(baseURL);
        if (target.origin !== base.origin) return url;
        const relative = `${target.pathname}${target.search}${target.hash}`;
        return relative || "/";
    } catch {
        return url;
    }
}

/** Safely parse a page's stored forms_json into a PageForms, or null. */
function parseForms(formsJson: string | null): PageForms | undefined {
    if (!formsJson) return undefined;
    try {
        const parsed = JSON.parse(formsJson) as PageForms;
        if (!parsed || !Array.isArray(parsed.fields)) return undefined;
        if (parsed.fields.length === 0 && (parsed.submits?.length ?? 0) === 0) return undefined;
        return parsed;
    } catch {
        return undefined;
    }
}

/**
 * Load site knowledge from the database.
 * Returns aggregated site discovery data for use in agent context.
 *
 * @param projectPath - Path to the project
 * @param _targetUrl - Optional URL to filter knowledge (currently unused, returns all knowledge)
 * @returns Site knowledge or null if no discovery data exists
 */
export async function loadSiteKnowledge(
    projectPath: string,
    _targetUrl?: string,
): Promise<SiteKnowledge | null> {
    try {
        const db = new CodeGraphDB(projectPath);
        const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), projectPath);

        // Check if any discovery has been done
        const stats = siteDb.getStats();
        if (stats.pagesCount === 0) {
            db.close();
            return null;
        }

        // Load verified navigation paths
        const verifiedLinks = siteDb.getVerifiedLinks();
        const verifiedPaths: NavigationPath[] = verifiedLinks.map((link) => ({
            fromUrl: link.fromUrl,
            toUrl: link.toUrl,
            selector: link.selector,
            linkText: link.linkText,
            verified: true,
        }));

        // Load auth-required routes. Only genuine auth blockers imply a login
        // wall — mapping every blocker category (consent, captcha, paywall,
        // manual pause, …) to "auth required" told the generator to log in for
        // pages that just had a cookie banner.
        const authRequiredRoutes = Array.from(
            new Set(
                siteDb
                    .getAllBlockers()
                    .filter((blocker) => blocker.category === "auth_required")
                    .map((blocker) => blocker.url),
            ),
        );

        // Build selector hints from verified links
        const selectorCounts = new Map<
            string,
            { count: number; url: string; role: string | null }
        >();

        for (const link of verifiedLinks) {
            const key = link.selector;
            const existing = selectorCounts.get(key);

            if (existing) {
                existing.count++;
            } else {
                selectorCounts.set(key, {
                    count: 1,
                    url: link.fromUrl,
                    role: link.elementRole,
                });
            }
        }

        const workingSelectors: SelectorHint[] = Array.from(selectorCounts.entries())
            .map(([selector, data]) => ({
                selector,
                url: data.url,
                elementRole: data.role,
                usageCount: data.count,
            }))
            .sort((a, b) => b.usageCount - a.usageCount)
            .slice(0, 20); // Top 20 selectors

        // Load broken links
        const brokenLinks = siteDb.getBrokenLinks().map((link) => link.toUrl);

        // The authoritative route catalog: every page discovery actually
        // loaded. Surfacing this (URL + title) is what lets the generator use
        // real routes instead of guessing "/login", "/dashboard", etc.
        const routes: DiscoveredRoute[] = siteDb
            .getAllPages()
            .slice(0, MAX_ROUTES)
            .map((page) => ({
                url: page.url,
                title: page.title,
                depth: page.depth,
                forms: parseForms(page.formsJson),
            }));

        const siteKnowledge: SiteKnowledge = {
            pagesDiscovered: stats.pagesCount,
            routes,
            verifiedPaths,
            authRequiredRoutes: [...new Set(authRequiredRoutes)], // Deduplicate
            workingSelectors,
            brokenLinks: [...new Set(brokenLinks)], // Deduplicate
        };

        db.close();
        return siteKnowledge;
    } catch (error) {
        console.error("Failed to load site knowledge:", error);
        return null;
    }
}

/**
 * Format site knowledge as a string for inclusion in agent prompts.
 *
 * @param knowledge - Site knowledge object
 * @returns Formatted string for prompt context
 */
export function formatSiteKnowledge(knowledge: SiteKnowledge, baseURL?: string | null): string {
    const sections: string[] = [];

    sections.push("## Site Discovery Knowledge\n");
    sections.push(
        `Raiken has autonomously discovered ${knowledge.pagesDiscovered} pages in this application.\n`,
    );

    // Discovered routes: the authoritative page catalog. These are the ONLY
    // real routes — the generator must navigate to one of these, never invent
    // a URL. Listed before everything else so it anchors the whole context.
    if (knowledge.routes.length > 0) {
        sections.push("### Discovered Routes (authoritative — use these exact URLs)\n");
        sections.push("Every route below was actually loaded during discovery. ");
        sections.push(
            "Use these exact URLs/paths in tests. Do NOT invent or guess routes that are not listed here. ",
        );
        sections.push(
            "Where a page lists Form fields, use those exact fields/attributes to build locators (getByLabel / getByPlaceholder / name) — do not invent field names.\n",
        );
        for (const route of knowledge.routes) {
            const title = route.title ? ` — ${route.title}` : "";
            sections.push(`- ${toDisplayUrl(route.url, baseURL)}${title}\n`);
            if (route.forms) {
                for (const field of route.forms.fields.slice(0, MAX_FIELDS_PER_PAGE)) {
                    const attrs: string[] = [`type=${field.type}`];
                    if (field.name) attrs.push(`name=${field.name}`);
                    if (field.id) attrs.push(`id=${field.id}`);
                    if (field.testId) attrs.push(`testId=${field.testId}`);
                    if (field.placeholder) attrs.push(`placeholder="${field.placeholder}"`);
                    if (field.required) attrs.push("required");
                    const label = field.label || "(unlabeled)";
                    sections.push(`    • field "${label}" [${attrs.join(", ")}]\n`);
                }
                if (route.forms.fields.length > MAX_FIELDS_PER_PAGE) {
                    sections.push(
                        `    • ...and ${route.forms.fields.length - MAX_FIELDS_PER_PAGE} more fields\n`,
                    );
                }
                if (route.forms.submits.length > 0) {
                    sections.push(
                        `    • submit: ${route.forms.submits.map((s) => `"${s}"`).join(", ")}\n`,
                    );
                }
            }
        }
        if (knowledge.pagesDiscovered > knowledge.routes.length) {
            sections.push(
                `\n...and ${knowledge.pagesDiscovered - knowledge.routes.length} more discovered pages.\n`,
            );
        }
        sections.push("\n");
    }

    // Verified navigation paths
    if (knowledge.verifiedPaths.length > 0) {
        sections.push("### Verified Navigation Paths\n");
        sections.push("These navigation paths have been verified to work:\n");

        for (const path of knowledge.verifiedPaths.slice(0, 10)) {
            const linkText = path.linkText ? ` ("${path.linkText}")` : "";
            sections.push(
                `- ${toDisplayUrl(path.fromUrl, baseURL)} → ${toDisplayUrl(path.toUrl, baseURL)}${linkText}\n`,
            );
            sections.push(`  Selector: \`${path.selector}\`\n`);
        }

        if (knowledge.verifiedPaths.length > 10) {
            sections.push(`\n...and ${knowledge.verifiedPaths.length - 10} more verified paths.\n`);
        }
        sections.push("\n");
    }

    // Working selectors
    if (knowledge.workingSelectors.length > 0) {
        sections.push("### Recommended Selectors\n");
        sections.push("These selectors have been used successfully in this application:\n");

        for (const hint of knowledge.workingSelectors.slice(0, 10)) {
            const role = hint.elementRole ? ` (role: ${hint.elementRole})` : "";
            sections.push(`- \`${hint.selector}\`${role} - used ${hint.usageCount}x\n`);
        }
        sections.push("\n");
    }

    // Auth-required routes
    if (knowledge.authRequiredRoutes.length > 0) {
        sections.push("### Authentication Required\n");
        sections.push("These routes require authentication:\n");

        for (const route of knowledge.authRequiredRoutes.slice(0, 5)) {
            sections.push(`- ${toDisplayUrl(route, baseURL)}\n`);
        }

        if (knowledge.authRequiredRoutes.length > 5) {
            sections.push(
                `\n...and ${knowledge.authRequiredRoutes.length - 5} more protected routes.\n`,
            );
        }
        sections.push("\n");
    }

    // Broken links
    if (knowledge.brokenLinks.length > 0) {
        sections.push("### Known Broken Links\n");
        sections.push("These URLs should be avoided in tests:\n");

        for (const url of knowledge.brokenLinks.slice(0, 5)) {
            sections.push(`- ${url}\n`);
        }

        if (knowledge.brokenLinks.length > 5) {
            sections.push(`\n...and ${knowledge.brokenLinks.length - 5} more broken links.\n`);
        }
        sections.push("\n");
    }

    return sections.join("");
}
