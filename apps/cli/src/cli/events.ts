/**
 * Structured event stream for `raiken -p --stream-json`.
 *
 * Emits one NDJSON object per line on stdout so editors/CI can follow a run
 * without scraping human text. Human diagnostics stay on stderr.
 */

export type AgentStreamEvent =
    | { type: "start"; prompt: string; ts: number }
    | { type: "tool"; name: string; args?: unknown; ts: number }
    | { type: "progress"; label: string; detail?: string | null; ts: number }
    | { type: "text"; text: string; ts: number }
    | { type: "hitl"; kind: string; payload: Record<string, unknown>; ts: number }
    | {
          type: "done";
          ok: boolean;
          response?: string;
          /** Present when the streamed text was superseded by a regenerated draft. */
          finalDraft?: string;
          savedTest?: string | null;
          /** Why a requested save didn't happen/succeed, when `ok` is false because of it. */
          saveError?: string | null;
          /**
           * Why the run is not ok, covering every cause: a failed save, a
           * missing artifact, a run that never happened, or failing tests.
           */
          reason?: string;
          /** Cover-equivalent honesty gates on the produced draft. */
          needsReview?: boolean;
          blocked?: boolean;
          reviewReasons?: string[];
          /** AI verdict on a failed run: is the test or the application at fault? */
          diagnosis?: string | null;
          run?: {
              success: boolean;
              passed: number;
              failed: number;
              skipped: number;
          } | null;
          error?: string;
          ts: number;
      };

export interface EventStream {
    emit(event: AgentStreamEvent): void;
    enabled: boolean;
}

/** Create a stdout NDJSON emitter. When disabled, emit() is a no-op. */
export function createEventStream(enabled: boolean): EventStream {
    return {
        enabled,
        emit(event: AgentStreamEvent): void {
            if (!enabled) return;
            process.stdout.write(`${JSON.stringify(event)}\n`);
        },
    };
}

export function nowTs(): number {
    return Date.now();
}
