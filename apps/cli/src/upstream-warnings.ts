/**
 * Imported FIRST in bin.ts: filters unactionable third-party console nags
 * that fire at module-init time. `baseline-browser-mapping` (a transitive
 * Playwright dep bundled into the CLI) prints a "data is over two months
 * old" warning on every invocation — including --version and --help — and
 * users can't act on it because they don't own that dependency. Match the
 * exact package-prefix tag and pass everything else through untouched.
 */

const SUPPRESSED_PREFIXES = ["[baseline-browser-mapping]"];

function isSuppressed(args: unknown[]): boolean {
    const first = args[0];
    return (
        typeof first === "string" && SUPPRESSED_PREFIXES.some((prefix) => first.startsWith(prefix))
    );
}

const originalWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
    if (isSuppressed(args)) return;
    originalWarn(...args);
};
