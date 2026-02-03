import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export class TestStorage {
    private projectPath: string;
    private tempDir: string;

    constructor(projectPath: string) {
        this.projectPath = projectPath;
        this.tempDir = path.join(os.tmpdir(), "raiken-tests");

        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    async saveToTemp(testCode: string, testName?: string): Promise<string> {
        const fileName = testName
            ? `${this.sanitizeFileName(testName)}.spec.ts`
            : `test-${Date.now()}.spec.ts`;
        const filePath = path.join(this.tempDir, fileName);
        await fs.promises.writeFile(filePath, testCode, "utf-8");
        return filePath;
    }

    async saveToProject(testCode: string, testDirectory: string, fileName: string): Promise<string> {
        const testDir = path.join(this.projectPath, testDirectory);
        if (!fs.existsSync(testDir)) {
            fs.mkdirSync(testDir, { recursive: true });
        }
        const filePath = path.join(testDir, fileName);
        await fs.promises.writeFile(filePath, testCode, "utf-8");
        return filePath;
    }

    async cleanupTemp(): Promise<void> {
        try {
            const files = await fs.promises.readdir(this.tempDir);
            for (const file of files) {
                await fs.promises.unlink(path.join(this.tempDir, file));
            }
        } catch {
            // Ignore cleanup errors
        }
    }

    private sanitizeFileName(name: string): string {
        return name
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 50);
    }
}
