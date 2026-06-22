/**
 * Site Knowledge Loader
 *
 * Loads discovered site knowledge from database and formats it for agent context.
 */

import { CodeGraphDB } from "../database/db";
import { SiteKnowledgeDB } from "./db";
import type { NavigationPath, SelectorHint, SiteKnowledge } from "./types";

/**
 * Load site knowledge from the database.
 * Returns aggregated site discovery data for use in agent context.
 *
 * @param projectPath - Path to the project
 * @param targetUrl - Optional URL to filter knowledge (currently unused, returns all knowledge)
 * @returns Site knowledge or null if no discovery data exists
 */
export async function loadSiteKnowledge(
    projectPath: string,
    targetUrl?: string,
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

        // Load auth-required routes
        const authBlockers = siteDb.getAllBlockers();
        const authRequiredRoutes = authBlockers.map((blocker) => blocker.url);

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

        const siteKnowledge: SiteKnowledge = {
            pagesDiscovered: stats.pagesCount,
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
export function formatSiteKnowledge(knowledge: SiteKnowledge): string {
    const sections: string[] = [];

    sections.push("## Site Discovery Knowledge\n");
    sections.push(
        `Raiken has autonomously discovered ${knowledge.pagesDiscovered} pages in this application.\n`,
    );

    // Verified navigation paths
    if (knowledge.verifiedPaths.length > 0) {
        sections.push("### Verified Navigation Paths\n");
        sections.push("These navigation paths have been verified to work:\n");

        for (const path of knowledge.verifiedPaths.slice(0, 10)) {
            const linkText = path.linkText ? ` ("${path.linkText}")` : "";
            sections.push(`- ${path.fromUrl} → ${path.toUrl}${linkText}\n`);
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
            sections.push(`- ${route}\n`);
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
