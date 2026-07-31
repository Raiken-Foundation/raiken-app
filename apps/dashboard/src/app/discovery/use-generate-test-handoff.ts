import { useEffect, useRef, useState } from "react";
import { GENERATE_TEST_HANDOFF_MS, TOAST_DISMISS_MS } from "./constants";
import { buildGenerateTestToast } from "./runtime-state";

export function useGenerateTestHandoff(onGenerateTest?: (pageUrl: string) => void) {
    const [toastMessage, setToastMessage] = useState<string | null>(null);
    const generateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        if (!toastMessage) return;
        const timer = setTimeout(() => setToastMessage(null), TOAST_DISMISS_MS);
        return () => clearTimeout(timer);
    }, [toastMessage]);

    useEffect(
        () => () => {
            if (generateTimerRef.current) clearTimeout(generateTimerRef.current);
        },
        [],
    );

    const handleGenerateTest = (pageUrl: string) => {
        setToastMessage(buildGenerateTestToast(pageUrl));
        if (generateTimerRef.current) clearTimeout(generateTimerRef.current);
        generateTimerRef.current = setTimeout(() => {
            generateTimerRef.current = null;
            onGenerateTest?.(pageUrl);
        }, GENERATE_TEST_HANDOFF_MS);
    };

    return { toastMessage, handleGenerateTest };
}
