import type { getQuickInterpretation, getTestRepair } from "@raiken/core";
import { z } from "zod";
import { appFor } from "./app-context";
import { procedure } from "./trpc";

const testResultSchema = z.object({
    name: z.string(),
    suite: z.string(),
    status: z.enum(["passed", "failed", "skipped"]),
    duration: z.number().optional(),
    error: z
        .object({
            message: z.string().optional(),
            snippet: z.string().optional(),
            location: z
                .object({
                    file: z.string(),
                    line: z.number(),
                    column: z.number(),
                })
                .optional(),
        })
        .optional(),
    attachments: z
        .array(
            z.object({
                name: z.string(),
                contentType: z.string().optional(),
                path: z.string().optional(),
            }),
        )
        .optional(),
});

const domContextSchema = z
    .object({
        url: z.string(),
        title: z.string(),
        interactiveElements: z.array(
            z.object({
                tagName: z.string(),
                role: z.string().optional(),
                name: z.string().optional(),
                text: z.string().optional(),
                testId: z.string().optional(),
                suggestedSelectors: z.array(z.string()),
            }),
        ),
        formFields: z.array(
            z.object({
                name: z.string(),
                type: z.string(),
                label: z.string().optional(),
                placeholder: z.string().optional(),
                required: z.boolean(),
                suggestedSelector: z.string(),
            }),
        ),
    })
    .optional();

export const testingRouter = {
    saveGeneratedTest: procedure
        .input(
            z.object({
                fileName: z.string(),
                content: z.string(),
                testDir: z.string().optional(),
                sourceFiles: z.array(z.string()).optional(),
                avoidOverwrite: z.boolean().optional(),
            }),
        )
        .mutation(({ input, ctx }) => appFor(ctx).testing.saveGeneratedTest(input)),

    saveFileContent: procedure
        .input(
            z.object({
                filePath: z.string(),
                content: z.string(),
            }),
        )
        .mutation(({ input, ctx }) => appFor(ctx).testing.saveFileContent(input)),

    deleteTestFile: procedure
        .input(z.object({ filePath: z.string() }))
        .mutation(({ input, ctx }) => appFor(ctx).testing.deleteTestFile(input)),

    renameTestFile: procedure
        .input(
            z.object({
                filePath: z.string(),
                newFileName: z.string(),
            }),
        )
        .mutation(({ input, ctx }) => appFor(ctx).testing.renameTestFile(input)),

    listTestFiles: procedure
        .input(z.object({ testDir: z.string().optional() }))
        .query(({ input, ctx }) => appFor(ctx).testing.listTestFiles(input)),

    runTests: procedure
        .input(
            z.object({
                testFile: z.string().optional(),
                testName: z.string().optional(),
                parallel: z.boolean().default(true),
                workers: z.number().optional(),
                inlineContent: z.string().optional(),
                inlineFileName: z.string().optional(),
            }),
        )
        .mutation(({ input, ctx }) => appFor(ctx).testing.runTests(input)),

    cancelTestRun: procedure
        .input(z.object({ runId: z.string().uuid().optional() }))
        .mutation(({ input, ctx }) => appFor(ctx).testing.cancelTestRun(input.runId)),

    generateTestReport: procedure
        .input(
            z.object({
                report: z.unknown().optional(),
                rawReportJson: z.string().optional(),
                rawOutput: z.string().optional(),
                testFile: z.string().optional(),
                title: z.string().optional(),
                formats: z.array(z.enum(["html", "markdown", "json"])).optional(),
                outputDir: z.string().optional(),
                embedScreenshots: z.boolean().optional(),
            }),
        )
        .mutation(({ input, ctx }) => appFor(ctx).testing.generateTestReport(input)),

    generatePlaywrightConfig: procedure
        .input(
            z.object({
                testDir: z.string().optional(),
                parallel: z.boolean().optional(),
                workers: z.union([z.number(), z.literal("auto")]).optional(),
                retries: z.number().optional(),
                timeout: z.number().optional(),
            }),
        )
        .mutation(({ input, ctx }) => appFor(ctx).testing.generatePlaywrightConfig(input)),

    checkPlaywrightConfig: procedure.query(({ ctx }) =>
        appFor(ctx).testing.checkPlaywrightConfig(),
    ),

    interpretTestResults: procedure
        .input(
            z.object({
                testResults: z.array(testResultSchema),
                testCode: z.string(),
                testFilePath: z.string().optional(),
                rawOutput: z.string().optional(),
                sourceCode: z.string().optional(),
                domContext: domContextSchema,
            }),
        )
        .mutation(({ input, ctx }) =>
            appFor(ctx).testing.interpretTestResults({
                ...input,
                domContext: input.domContext as Parameters<
                    typeof getQuickInterpretation
                >[0]["domContext"],
            }),
        ),

    repairTestResults: procedure
        .input(
            z.object({
                testResults: z.array(testResultSchema),
                testCode: z.string(),
                testFilePath: z.string().optional(),
                rawOutput: z.string().optional(),
                sourceCode: z.string().optional(),
                interpretation: z.string().optional(),
                domContext: domContextSchema,
            }),
        )
        .mutation(({ input, ctx }) =>
            appFor(ctx).testing.repairTestResults({
                ...input,
                domContext: input.domContext as Parameters<typeof getTestRepair>[0]["domContext"],
            }),
        ),
};
