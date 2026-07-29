import * as fs from "node:fs/promises";
import { resolvePathWithinProject } from "../config";

export class ProjectArtifactService {
    constructor(private readonly projectPath: string) {}

    resolve(relativePath: string): string {
        return resolvePathWithinProject(this.projectPath, relativePath);
    }

    async read(relativePath: string): Promise<Buffer> {
        return fs.readFile(this.resolve(relativePath));
    }
}
