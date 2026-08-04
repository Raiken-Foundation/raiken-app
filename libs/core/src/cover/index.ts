export {
    type AssessGeneratedDraftInput,
    type AssessGeneratedDraftResult,
    assessGeneratedDraft,
    assessTodoMarkers,
    containsUnverifiedMarker,
    describeSignedOutKnowledgeGap,
    UNVERIFIED_MARKER,
} from "./assess-draft";
export {
    type CoverEvent,
    type CoverOptions,
    type CoverResult,
    type CoverTargetKind,
    extractAcs,
    runCover,
    UNVERIFIED_MARKER_LINE,
} from "./cover";
export {
    type AssertionPolarityAssessment,
    assessAssertionPolarity,
    assessDraftStructure,
    assessPlaywrightFit,
    describeTestMatchRemedy,
    isRestrictiveTestMatch,
    matchesPlaywrightTestPattern,
    suggestCollectedOutputPath,
} from "./draft-quality";
export {
    type AuthLoginEvidence,
    type CoverEvidence,
    extractOrigins,
    formatAuthLoginEvidence,
    gatherCoverEvidence,
    gatherRepairEvidence,
    hasAuthGrounding,
    looksLikeAuthScenario,
    type RepairEvidence,
    rankPagesByScenario,
    readAuthLoginEvidence,
} from "./evidence";
export {
    loadRecordedCoverFlows,
    persistCoverFlows,
    recordLoginFlowFromEvidence,
    writeLoginScriptFromEvidence,
} from "./flow-store";
export {
    buildNavigationFlows,
    type CoverFlow,
    type CoverFlowStep,
    formatNavigationFlows,
} from "./flows";
export {
    assessIntentCoverage,
    extractDraftSignalTokens,
    extractIntentCriteria,
    type IntentCoverageAssessment,
    type IntentCriterion,
    significantTokens,
    splitScenarioClauses,
} from "./intent-coverage";
export {
    BOUNDED_DISCOVER_MAX_DEPTH,
    BOUNDED_DISCOVER_MAX_PAGES,
    type EnsureSiteKnowledgeOptions,
    type EnsureSiteKnowledgeResult,
    ensureSiteKnowledge,
    hasAuthenticatedSiteKnowledge,
    hasUsableSiteKnowledge,
    resolveDiscoverSeedUrl,
    resolveUsableSessionPath,
    runBoundedDiscover,
    siteKnowledgeRefuseMessage,
} from "./knowledge-gate";
export {
    captureRepairPage,
    discoveryCoversUrl,
    extractFirstGotoTarget,
    type LiveRepairCaptureResult,
    maybeCaptureMissingRepairPage,
    type RepairCaptureDecision,
    resolveFailureUrl,
    shouldLiveCaptureRepairPage,
} from "./repair-capture";
export {
    applyRepairSetupFixes,
    containsParentTraversal,
    describeDroppedScenarioExpectation,
    describeParentTraversal,
    describeReassertedAbsence,
    describeRegressedSelector,
    describeTimeoutFocus,
    extractPendingLocators,
    extractProvenAbsentLocators,
    extractProvenPresentSelectors,
    missingScenarioExpectations,
    type ProvenSelector,
    type SetupFixResult,
    scenarioExpectedTokens,
    stillAssertsAbsentLocators,
} from "./repair-setup";
