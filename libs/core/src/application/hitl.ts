import { advanceHitlWorkflow, continueHitlWorkflow } from "../workflows/continue-hitl-workflow";
import { WorkflowStore } from "../workflows/workflow-store";
import type { ProjectApplicationContext } from "./context";

/** Durable HITL workflow continuation and listing. */
export class HitlApplication implements ProjectApplicationContext {
    readonly projectPath: string;

    constructor(projectPath: string) {
        this.projectPath = projectPath;
    }

    continue(
        input:
            | {
                  workflowId: string;
                  action: "save";
                  decision: "approve" | "reject";
                  filePath?: string;
                  avoidOverwrite?: boolean;
              }
            | {
                  workflowId: string;
                  action: "run";
                  decision: "approve" | "reject";
              },
    ) {
        return continueHitlWorkflow({
            projectPath: this.projectPath,
            ...input,
        });
    }

    listActive() {
        return new WorkflowStore(this.projectPath).listActive();
    }

    advance(workflowId: string) {
        return advanceHitlWorkflow({
            projectPath: this.projectPath,
            workflowId,
        });
    }
}
