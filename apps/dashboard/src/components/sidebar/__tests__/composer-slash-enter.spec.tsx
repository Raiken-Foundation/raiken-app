import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useComposer } from "../composer/use-composer";

// useComposer only needs `trpc.useUtils()` for slash-command side effects we
// don't exercise here; stub the whole module so the hook mounts without a
// tRPC provider.
vi.mock("../../../utils/trpc", () => ({
    trpc: {
        useUtils: () => ({}),
    },
}));

function makeComposer(overrides: Partial<Parameters<typeof useComposer>[0]> = {}) {
    return renderHook(() =>
        useComposer({
            isGenerating: false,
            sourceFiles: [],
            handleClearChat: vi.fn(),
            echoSystemMessage: vi.fn(),
            handleStop: () => false,
            ...overrides,
        }),
    );
}

function type(result: { current: ReturnType<typeof useComposer> }, value: string) {
    act(() => {
        result.current.handleInputChange({
            target: { value, selectionStart: value.length },
        } as React.ChangeEvent<HTMLTextAreaElement>);
    });
}

function pressEnter(result: { current: ReturnType<typeof useComposer> }) {
    const preventDefault = vi.fn();
    act(() => {
        result.current.handleKeyDown({
            key: "Enter",
            shiftKey: false,
            preventDefault,
            stopPropagation: vi.fn(),
        } as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
    });
    return preventDefault;
}

async function flushMicrotasks() {
    await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("composer slash menu", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("filters matches as the query is typed", () => {
        const { result } = makeComposer();
        type(result, "/doc");
        expect(result.current.showSlashAutocomplete).toBe(true);
        expect(result.current.slashMatches.map((c) => c.name)).toEqual(["doctor"]);
    });

    it("Enter runs the highlighted arg-less command (not the raw partial text)", async () => {
        const requestSubmit = vi.fn();
        const { result } = makeComposer();
        result.current.formRef.current = { requestSubmit } as unknown as HTMLFormElement;

        type(result, "/doc");
        const preventDefault = pressEnter(result);
        await flushMicrotasks();

        expect(preventDefault).toHaveBeenCalled();
        expect(result.current.inputValue).toBe("/doctor");
        expect(result.current.showSlashAutocomplete).toBe(false);
        expect(requestSubmit).toHaveBeenCalledTimes(1);
    });

    it("Enter only completes commands that take arguments", async () => {
        const requestSubmit = vi.fn();
        const { result } = makeComposer();
        result.current.formRef.current = { requestSubmit } as unknown as HTMLFormElement;

        type(result, "/cov");
        expect(result.current.slashMatches.map((c) => c.name)).toContain("cover");
        pressEnter(result);
        await flushMicrotasks();

        expect(result.current.inputValue).toBe("/cover ");
        expect(requestSubmit).not.toHaveBeenCalled();
    });

    it("arrow navigation moves the highlight before Enter runs it", async () => {
        const requestSubmit = vi.fn();
        const { result } = makeComposer();
        result.current.formRef.current = { requestSubmit } as unknown as HTMLFormElement;

        type(result, "/d");
        const matches = result.current.slashMatches;
        expect(matches.map((c) => c.name)).toEqual(["discovery", "doctor", "build"]);
        act(() => {
            result.current.handleKeyDown({
                key: "ArrowDown",
                preventDefault: vi.fn(),
            } as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
        });
        expect(result.current.slashPosition).toBe(1);
        pressEnter(result);
        await flushMicrotasks();

        expect(result.current.inputValue).toBe(`/${matches[1].name}`);
        expect(requestSubmit).toHaveBeenCalledTimes(1);
    });
});
