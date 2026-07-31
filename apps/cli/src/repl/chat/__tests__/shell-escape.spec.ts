import { describe, expect, it, vi } from "vitest";
import { handleShell } from "../shell-escape";
import type { ChatReplContext } from "../types";

vi.mock("../../shell", () => ({
    runShellCommand: vi.fn().mockResolvedValue({
        command: "echo hi",
        code: 0,
        stdout: "hi\n",
        stderr: "",
    }),
    printShellSummary: vi.fn(),
}));

describe("shell escape", () => {
    it("rejects empty shell commands", async () => {
        const logs: string[] = [];
        const originalLog = console.log;
        console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
        try {
            await handleShell({ projectPath: "/proj" } as ChatReplContext, "   ");
            expect(logs.join("\n")).toMatch(/usage: !/);
        } finally {
            console.log = originalLog;
        }
    });

    it("runs non-empty commands in project cwd", async () => {
        const { runShellCommand, printShellSummary } = await import("../../shell");
        await handleShell({ projectPath: "/proj" } as ChatReplContext, "echo hi");
        expect(runShellCommand).toHaveBeenCalledWith("echo hi", "/proj");
        expect(printShellSummary).toHaveBeenCalled();
    });
});
