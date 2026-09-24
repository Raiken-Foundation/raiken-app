import type { GraphStateType } from "../state";
import { buildSummary } from "../utils";

export const createSummarizeNode = () => async (state: GraphStateType) => ({
    summary: state.summary || buildSummary(state),
});
