/**
 * Decide whether a save should dedupe to `name-2.spec.ts` or overwrite.
 *
 * `saveGeneratedTest`'s `avoidOverwrite` guard exists so two unrelated
 * generations can't silently clobber each other — the agent invents a file
 * name from the draft, and that name may already belong to someone else's
 * spec. But the same guard applied to a path the run *deliberately* targeted
 * turns a requested update into a near-duplicate file: the user approves
 * "save to e2e/login.spec.ts", and `e2e/login-2.spec.ts` appears instead
 * while the file they meant to fix stays broken.
 *
 * So dedupe only an auto-suggested path that nobody has touched. Two signals
 * mean "this exact file is the destination":
 *   - `overwriteTarget`: the agent aimed at an existing spec (the file the
 *     user had open, or one named in the prompt);
 *   - the user typed a different path into the approval card, which is as
 *     explicit as intent gets — and the card shows exactly where it lands.
 */
export function shouldAvoidOverwrite(input: {
    /** Path the agent proposed. */
    suggestedPath: string | undefined;
    /** Path being saved, after any edit in the approval card. */
    requestedPath: string;
    /** Whether the agent flagged `suggestedPath` as an existing target. */
    overwriteTarget: boolean | undefined;
}): boolean {
    if (input.overwriteTarget === true) return false;
    const suggested = (input.suggestedPath ?? "").trim();
    const userEditedPath = suggested.length > 0 && input.requestedPath.trim() !== suggested;
    return !userEditedPath;
}
