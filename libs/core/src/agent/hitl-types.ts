/**
 * Human-In-The-Loop (HITL) Types
 *
 * Defines the actions that require human confirmation before proceeding.
 * The orchestrator pauses at these checkpoints and waits for user input.
 */

/**
 * Types of HITL actions
 */
export type HITLActionType = "save" | "run" | "correct" | "learn";

/**
 * Base interface for all HITL actions
 */
export interface HITLActionBase {
    type: HITLActionType;
    timestamp: number;
}

/**
 * Save confirmation - before saving test to disk
 */
export interface HITLSaveAction extends HITLActionBase {
    type: "save";
    testCode: string;
    suggestedPath: string;
    testName: string;
    /**
     * True when `suggestedPath` is a file the run deliberately targeted (the
     * spec the user had open, or one named in the prompt) rather than a name
     * derived from the draft. Approvers must not dedupe such a path to
     * `name-2.spec.ts`: the whole point of the request was to update that
     * file, and writing a near-duplicate beside it silently loses the edit.
     */
    overwriteTarget?: boolean;
}

/**
 * Run confirmation - before executing test
 */
export interface HITLRunAction extends HITLActionBase {
    type: "run";
    testFile: string;
    testName: string;
    warnings?: string[];
}

/**
 * Correction confirmation - before applying auto-fix
 */
export interface HITLCorrectAction extends HITLActionBase {
    type: "correct";
    originalCode: string;
    correctedCode: string;
    failureReason: string;
    diff: string;
    failingSelector?: string;
}

/**
 * Learn confirmation - before storing a preference/pattern
 */
export interface HITLLearnAction extends HITLActionBase {
    type: "learn";
    learnType: "selector" | "preference" | "pattern";
    description: string;
    value: string;
    context?: string;
}

/**
 * Union type for all HITL actions
 */
export type HITLAction = HITLSaveAction | HITLRunAction | HITLCorrectAction | HITLLearnAction;

/**
 * User response to a HITL action
 */
export interface HITLResponse {
    actionType: HITLActionType;
    decision: "confirm" | "reject" | "edit";
    /** Modified value if decision is 'edit' */
    editedValue?: string;
    /** Custom path if user wants different location */
    customPath?: string;
    /** Remember this decision for future */
    rememberDecision?: boolean;
}

/**
 * HITL checkpoint state for orchestrator
 */
export interface HITLCheckpoint {
    /** Unique ID for this checkpoint */
    id: string;
    /** The action requiring confirmation */
    action: HITLAction;
    /** Whether a response has been received */
    responded: boolean;
    /** The user's response (if received) */
    response?: HITLResponse;
    /** Timeout in ms (0 = wait indefinitely) */
    timeout: number;
    /** Callback when resolved */
    resolve?: (response: HITLResponse) => void;
}

/**
 * Create a HITL save action
 */
export function createSaveAction(
    testCode: string,
    suggestedPath: string,
    testName: string,
    overwriteTarget = false,
): HITLSaveAction {
    return {
        type: "save",
        timestamp: Date.now(),
        testCode,
        suggestedPath,
        testName,
        overwriteTarget,
    };
}

/**
 * Create a HITL run action
 */
export function createRunAction(
    testFile: string,
    testName: string,
    warnings?: string[],
): HITLRunAction {
    return {
        type: "run",
        timestamp: Date.now(),
        testFile,
        testName,
        warnings,
    };
}

/**
 * Create a HITL correct action
 */
export function createCorrectAction(
    originalCode: string,
    correctedCode: string,
    failureReason: string,
    failingSelector?: string,
): HITLCorrectAction {
    return {
        type: "correct",
        timestamp: Date.now(),
        originalCode,
        correctedCode,
        failureReason,
        diff: generateSimpleDiff(originalCode, correctedCode),
        failingSelector,
    };
}

/**
 * Create a HITL learn action
 */
export function createLearnAction(
    learnType: "selector" | "preference" | "pattern",
    description: string,
    value: string,
    context?: string,
): HITLLearnAction {
    return {
        type: "learn",
        timestamp: Date.now(),
        learnType,
        description,
        value,
        context,
    };
}

/**
 * Generate a simple diff between two strings.
 * For display purposes only.
 */
function generateSimpleDiff(original: string, modified: string): string {
    const originalLines = original.split("\n");
    const modifiedLines = modified.split("\n");
    const diff: string[] = [];

    const maxLines = Math.max(originalLines.length, modifiedLines.length);

    for (let i = 0; i < maxLines; i++) {
        const origLine = originalLines[i];
        const modLine = modifiedLines[i];

        if (origLine === modLine) {
            diff.push(`  ${origLine || ""}`);
        } else {
            if (origLine !== undefined) {
                diff.push(`- ${origLine}`);
            }
            if (modLine !== undefined) {
                diff.push(`+ ${modLine}`);
            }
        }
    }

    return diff.join("\n");
}

/**
 * Check if autonomy settings allow skipping HITL for an action type
 */
export function shouldSkipHITL(
    actionType: HITLActionType,
    autonomySettings: {
        autoSaveTests?: boolean;
        autoRunTests?: boolean;
        autoCorrect?: "suggest" | "apply" | "off";
        autoLearn?: "confirm" | "auto" | "off";
    },
): boolean {
    switch (actionType) {
        case "save":
            return autonomySettings.autoSaveTests === true;
        case "run":
            return autonomySettings.autoRunTests === true;
        case "correct":
            return autonomySettings.autoCorrect === "apply";
        case "learn":
            return autonomySettings.autoLearn === "auto";
        default:
            return false;
    }
}
