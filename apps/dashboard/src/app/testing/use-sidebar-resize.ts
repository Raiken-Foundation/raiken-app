import type { KeyboardEvent } from "react";
import { useEffect, useState } from "react";

export function useSidebarResize(initialWidth = 320) {
    const [sidebarWidth, setSidebarWidth] = useState(initialWidth);
    const [isResizing, setIsResizing] = useState(false);

    const handleMouseDown = () => {
        setIsResizing(true);
    };

    const handleResizeKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        const step = e.shiftKey ? 40 : 10;
        if (e.key === "ArrowLeft") {
            e.preventDefault();
            setSidebarWidth((w) => Math.max(280, w - step));
        } else if (e.key === "ArrowRight") {
            e.preventDefault();
            setSidebarWidth((w) => Math.min(600, w + step));
        }
    };

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (isResizing) {
                const newWidth = e.clientX;
                if (newWidth >= 280 && newWidth <= 600) {
                    setSidebarWidth(newWidth);
                }
            }
        };

        const handleMouseUp = () => {
            setIsResizing(false);
        };

        if (isResizing) {
            document.addEventListener("mousemove", handleMouseMove);
            document.addEventListener("mouseup", handleMouseUp);
            return () => {
                document.removeEventListener("mousemove", handleMouseMove);
                document.removeEventListener("mouseup", handleMouseUp);
            };
        }
    }, [isResizing]);

    return {
        sidebarWidth,
        isResizing,
        handleMouseDown,
        handleResizeKeyDown,
    };
}
