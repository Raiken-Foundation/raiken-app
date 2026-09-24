import type { DiffReview, TestFile } from "./types";

/** True when the AI-fix diff should replace the active file buffer. */
export function shouldShowDiff(
    diffReview: DiffReview | null | undefined,
    activeFile: TestFile | undefined,
): boolean {
    if (!diffReview) return false;
    return !activeFile || activeFile.path === diffReview.targetPath;
}

export function getDiffMetaLabel(diffReview: DiffReview | null | undefined): string {
    if (!diffReview) return "";
    const diffIsEdits = diffReview.mode === "edits" && !!diffReview.editCount;
    return diffIsEdits
        ? `${diffReview.editCount} section edit${diffReview.editCount === 1 ? "" : "s"}`
        : "full rewrite";
}
