import { FieldGroup, ToggleSwitch } from "../fields/field-controls";
import type { SettingsFormApi } from "../types";
import { optionalNumber } from "../utils";

type DiscoverySectionProps = Pick<SettingsFormApi, "val" | "def" | "update">;

export function DiscoverySection({ val, def, update }: DiscoverySectionProps) {
    return (
        <>
            <FieldGroup
                label="Max Pages"
                hint={`Maximum pages to discover in a single crawl session (default: ${def("discovery", "maxPages")}).`}
            >
                <input
                    type="number"
                    min={1}
                    value={
                        (val("discovery", "maxPages") as number) ??
                        (def("discovery", "maxPages") as number)
                    }
                    onChange={(e) =>
                        update("discovery", "maxPages", optionalNumber(e.target.value))
                    }
                />
            </FieldGroup>
            <FieldGroup
                label="Max Depth"
                hint={`How many navigation levels deep to crawl (default: ${def("discovery", "maxDepth")}).`}
            >
                <input
                    type="number"
                    min={1}
                    max={20}
                    value={
                        (val("discovery", "maxDepth") as number) ??
                        (def("discovery", "maxDepth") as number)
                    }
                    onChange={(e) =>
                        update("discovery", "maxDepth", optionalNumber(e.target.value))
                    }
                />
            </FieldGroup>
            <FieldGroup label="Concurrency" hint="Number of pages crawled simultaneously.">
                <input
                    type="number"
                    min={1}
                    max={10}
                    value={
                        (val("discovery", "maxConcurrency") as number) ??
                        (def("discovery", "maxConcurrency") as number)
                    }
                    onChange={(e) =>
                        update("discovery", "maxConcurrency", optionalNumber(e.target.value))
                    }
                />
            </FieldGroup>
            <FieldGroup label="Timeout (ms)" hint="Per-page navigation timeout.">
                <input
                    type="number"
                    min={1000}
                    step={1000}
                    value={
                        (val("discovery", "timeout") as number) ??
                        (def("discovery", "timeout") as number)
                    }
                    onChange={(e) => update("discovery", "timeout", optionalNumber(e.target.value))}
                />
            </FieldGroup>
            <FieldGroup
                label="Pause on Auth"
                hint="Pause crawling when an authentication wall is detected."
            >
                <ToggleSwitch
                    checked={(val("discovery", "pauseOnAuth") as boolean) ?? true}
                    onChange={(v) => update("discovery", "pauseOnAuth", v)}
                />
            </FieldGroup>
            <FieldGroup
                label="Exclude Patterns"
                hint="Comma-separated URL patterns to skip (e.g. /admin, /logout)."
            >
                <input
                    type="text"
                    value={((val("discovery", "excludePatterns") as string[]) ?? []).join(", ")}
                    onChange={(e) =>
                        update(
                            "discovery",
                            "excludePatterns",
                            e.target.value
                                .split(",")
                                .map((s) => s.trim())
                                .filter(Boolean),
                        )
                    }
                    placeholder="/admin, /logout"
                />
            </FieldGroup>
        </>
    );
}
