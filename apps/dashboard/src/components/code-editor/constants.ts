export const isMac =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || "");

export const MOD = isMac ? "⌘" : "Ctrl+";
