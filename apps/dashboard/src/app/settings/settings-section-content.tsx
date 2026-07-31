import { AdvancedSection } from "./sections/advanced-section";
import { AiSection } from "./sections/ai-section";
import { AuthSection } from "./sections/auth-section";
import { AutonomySection } from "./sections/autonomy-section";
import { BrowserSection } from "./sections/browser-section";
import { DiscoverySection } from "./sections/discovery-section";
import { FeaturesSection } from "./sections/features-section";
import { GeneralSection } from "./sections/general-section";
import { IntegrationsSection } from "./sections/integrations-section";
import type { Section, SettingsFormApi } from "./types";

export function SettingsSectionContent({
    section,
    formApi,
}: {
    section: Section;
    formApi: SettingsFormApi;
}) {
    switch (section) {
        case "general":
            return <GeneralSection form={formApi.form} updateTop={formApi.updateTop} />;
        case "ai":
            return <AiSection {...formApi} />;
        case "auth":
            return <AuthSection {...formApi} />;
        case "browser":
            return <BrowserSection {...formApi} />;
        case "discovery":
            return <DiscoverySection {...formApi} />;
        case "advanced":
            return <AdvancedSection {...formApi} />;
        case "features":
            return <FeaturesSection {...formApi} />;
        case "autonomy":
            return <AutonomySection {...formApi} />;
        case "integrations":
            return <IntegrationsSection {...formApi} />;
        default:
            return null;
    }
}
