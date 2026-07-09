/**
 * FIFO for prompts typed while an agent turn is still running.
 * Codex/Claude pattern: queue follow-ups, drain after the turn completes.
 */

export class InputQueue {
    private items: string[] = [];

    get length(): number {
        return this.items.length;
    }

    enqueue(line: string): number {
        const trimmed = line.trim();
        if (!trimmed) return this.items.length;
        this.items.push(trimmed);
        return this.items.length;
    }

    dequeue(): string | undefined {
        return this.items.shift();
    }

    peekAll(): string[] {
        return [...this.items];
    }

    clear(): void {
        this.items = [];
    }
}
