import { useState } from "react";
import { fetchServerArtifact } from "../../../utils/api-auth";

export function AuthenticatedArtifactLink({
    path,
    label,
    fileName,
}: {
    path: string;
    label: string;
    fileName: string;
}) {
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleOpen = async () => {
        if (isLoading) return;
        setIsLoading(true);
        setError(null);
        let popup: Window | null = null;

        try {
            popup = window.open("about:blank", "_blank");
            if (popup) popup.opener = null;
            const blob = await fetchServerArtifact(path);
            const objectUrl = URL.createObjectURL(blob);
            if (popup) {
                popup.location.assign(objectUrl);
            } else {
                const download = document.createElement("a");
                download.href = objectUrl;
                download.download = fileName;
                download.click();
            }
            window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
        } catch (openError) {
            popup?.close();
            setError(openError instanceof Error ? openError.message : "Unable to load artifact");
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <button
            type="button"
            className="view-btn"
            onClick={handleOpen}
            disabled={isLoading}
            title={error ?? undefined}
            aria-label={error ? `${label}: ${error}` : label}
        >
            {isLoading ? "Loading…" : error ? "Retry" : label}
        </button>
    );
}
