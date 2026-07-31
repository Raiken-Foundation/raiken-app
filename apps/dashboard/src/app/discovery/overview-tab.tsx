import type { ComponentProps } from "react";
import { BlockerPanel } from "./blockers/blocker-panel";
import { RunDiscoveryForm } from "./run-discovery-form";
import { RuntimeBanners } from "./runtime-banners";
import { RuntimeSummary } from "./runtime-summary";
import { TimelineSection } from "./timeline-section";
import type { BlockerRow, TimelineEventRow } from "./types";

interface OverviewTabProps {
    formProps: ComponentProps<typeof RunDiscoveryForm>;
    bannerProps: ComponentProps<typeof RuntimeBanners>;
    blockers: BlockerRow[];
    blockerPanelProps: Omit<ComponentProps<typeof BlockerPanel>, "blockers">;
    summaryProps: ComponentProps<typeof RuntimeSummary>;
    timeline: TimelineEventRow[];
}

export function OverviewTab({
    formProps,
    bannerProps,
    blockers,
    blockerPanelProps,
    summaryProps,
    timeline,
}: OverviewTabProps) {
    return (
        <div className="tab-content">
            <RunDiscoveryForm {...formProps} />
            <RuntimeBanners {...bannerProps} />
            {blockers.length > 0 && <BlockerPanel blockers={blockers} {...blockerPanelProps} />}
            <RuntimeSummary {...summaryProps} />
            <TimelineSection events={timeline} />
        </div>
    );
}
