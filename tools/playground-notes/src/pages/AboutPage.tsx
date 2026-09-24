import { useEffect } from "react";

export function AboutPage() {
    useEffect(() => {
        document.title = "About — Scrawl";
    }, []);

    return (
        <section data-testid="about-page">
            <h1>About Scrawl</h1>
            <p>
                Scrawl is a deterministic notes fixture used to exercise Raiken's discovery and
                draft-grounding pipeline. Notes, tags, and search are seeded; nothing here calls a
                server.
            </p>
            <p>
                Pinned notes sort to the top of the list. Tags keep personal and work thoughts
                apart.
            </p>
        </section>
    );
}
