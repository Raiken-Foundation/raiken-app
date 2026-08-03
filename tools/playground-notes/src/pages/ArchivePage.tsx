import { useEffect } from "react";
import { EmptyState } from "../components/EmptyState";

export function ArchivePage() {
    useEffect(() => {
        document.title = "Archive — Scrawl";
    }, []);

    // Deliberately unlinked from the nav: nothing on the site points here, so
    // discovery should never find it through links.
    return (
        <section data-testid="archive-page">
            <EmptyState title="Archive is empty" message="Archived notes would appear here." />
        </section>
    );
}
