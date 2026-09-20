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
    applyAddWebServer,
    applyAlignBaseUrlPort,
    applyDoctorFix,
    applyDoctorFixes,
    applyWidenTestMatch,
    type DoctorFixId,
    type DoctorFixResult,
    doctorFixLabel,
    FIXABLE_DOCTOR_RULES,
    isFixableDoctorFinding,
} from "./fixes";
export {
    type DoctorFinding,
    type DoctorOptions,
    type DoctorReport,
    type DoctorSeverity,
    scanTests,
} from "./scan";
