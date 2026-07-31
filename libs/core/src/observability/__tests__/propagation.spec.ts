import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { correlationFields, mergeCorrelationContext, runWithCorrelationContext } from "../context";

describe("workflow and discovery session correlation propagation", () => {
    let projectPath: string;

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-corr-"));
    });

    afterEach(() => {
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    it("propagates workflowId through async local storage", () => {
        runWithCorrelationContext({ workflowId: "wf-abc", projectPath }, () => {
            expect(correlationFields().workflowId).toBe("wf-abc");
        });
    });

    it("propagates discoverySessionId separately from operationId", () => {
        runWithCorrelationContext({ projectPath }, () => {
            mergeCorrelationContext({
                operationId: "op-9",
                discoverySessionId: "42",
                projectPath,
            });
            const fields = correlationFields();
            expect(fields.operationId).toBe("op-9");
            expect(fields.discoverySessionId).toBe("42");
            expect(fields.workflowId).toBeUndefined();
        });
    });

    it("merges workflowId without replacing operationId", () => {
        runWithCorrelationContext({ projectPath }, () => {
            mergeCorrelationContext({ operationId: "disc-1", projectPath });
            mergeCorrelationContext({ workflowId: "wf-hitl-1" });
            expect(correlationFields()).toMatchObject({
                operationId: "disc-1",
                workflowId: "wf-hitl-1",
            });
        });
    });
});
