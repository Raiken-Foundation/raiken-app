export {
    ENVIRONMENT_RULES,
    type EnvironmentScanOptions,
    findWebServerRunScripts,
    hasChromiumBrowser,
    readPackageScripts,
    resolvePlaywrightBrowsersPath,
    scanEnvironment,
} from "./environment";
export {
    type DoctorFinding,
    type DoctorOptions,
    type DoctorReport,
    type DoctorSeverity,
    scanTests,
} from "./scan";

export {
    applyAlignBaseUrlPort,
    applyAddWebServer,
    applyDoctorFix,
    applyDoctorFixes,
    applyWidenTestMatch,
    doctorFixLabel,
    FIXABLE_DOCTOR_RULES,
    isFixableDoctorFinding,
    type DoctorFixId,
    type DoctorFixResult,
} from "./fixes";
