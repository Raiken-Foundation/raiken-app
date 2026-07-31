import { describe, expect, it } from "vitest";
import {
    beginOperationScope,
    correlationFields,
    createCorrelationId,
    mergeCorrelationContext,
    runDetachedOperation,
    runWithCorrelationContext,
} from "../context";

describe("correlation context", () => {
    it("propagates ids through async local storage", async () => {
        const correlationId = createCorrelationId();
        await runWithCorrelationContext(
            { correlationId, operationId: "op-1", projectPath: "/tmp/my-proj" },
            async () => {
                expect(correlationFields()).toMatchObject({
                    correlationId,
                    operationId: "op-1",
                });
                expect(correlationFields().projectRef).toMatch(/^my-proj#[a-f0-9]{12}$/);
            },
        );
    });

    it("merges partial updates into the active context", () => {
        runWithCorrelationContext({ correlationId: "c1", projectPath: "/tmp/a" }, () => {
            mergeCorrelationContext({ runId: "run-9", workflowId: "wf-1" });
            expect(correlationFields()).toMatchObject({
                correlationId: "c1",
                runId: "run-9",
                workflowId: "wf-1",
            });
        });
    });

    it("returns a snapshot without binding when called outside a scope", () => {
        const snapshot = mergeCorrelationContext({ correlationId: "outside", runId: "r1" });
        expect(snapshot).toMatchObject({ correlationId: "outside", runId: "r1" });
        expect(correlationFields()).toEqual({});
    });

    it("isolates concurrent scopes", async () => {
        const results = await Promise.all([
            runWithCorrelationContext({ correlationId: "req-a" }, async () => {
                await new Promise((r) => setTimeout(r, 5));
                return correlationFields().correlationId;
            }),
            runWithCorrelationContext({ correlationId: "req-b" }, async () => {
                await new Promise((r) => setTimeout(r, 2));
                mergeCorrelationContext({ workflowId: "wf-b" });
                return correlationFields().correlationId;
            }),
        ]);
        expect(results).toEqual(["req-a", "req-b"]);
    });

    it("runDetachedOperation merges caller correlation and survives caller exit", async () => {
        let duringRun: string | undefined;
        let detached: Promise<void> | undefined;
        await runWithCorrelationContext(
            { correlationId: "parent-req", operationId: "parent-op" },
            async () => {
                detached = runDetachedOperation(
                    { operationId: "child-op", runId: "run-1" },
                    async () => {
                        duringRun = correlationFields().correlationId;
                        expect(correlationFields()).toMatchObject({
                            correlationId: "parent-req",
                            operationId: "child-op",
                            runId: "run-1",
                        });
                    },
                );
            },
        );
        expect(correlationFields()).toEqual({});
        await detached;
        expect(duringRun).toBe("parent-req");
    });

    it("beginOperationScope preserves async generator context", async () => {
        async function* scopedGen() {
            await Promise.resolve();
            yield correlationFields().correlationId;
        }
        const values: Array<string | undefined> = [];
        await runWithCorrelationContext({ correlationId: "gen-parent" }, async () => {
            const gen = beginOperationScope({ runId: "gen-run" }, () => scopedGen());
            for await (const value of gen) values.push(value);
        });
        expect(values).toEqual(["gen-parent"]);
    });
});
