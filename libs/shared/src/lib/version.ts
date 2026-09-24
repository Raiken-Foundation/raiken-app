import { RAIKEN_VERSION } from "./version.constant";

/** Browser-safe release version — no Node I/O. */
export function getRaikenVersion(): string {
    return RAIKEN_VERSION;
}
