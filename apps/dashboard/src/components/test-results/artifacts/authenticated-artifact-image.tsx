import { useEffect, useState } from "react";
import { fetchServerArtifact } from "../../../utils/api-auth";

export function AuthenticatedArtifactImage({ path, name }: { path: string; name: string }) {
    const [objectUrl, setObjectUrl] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const controller = new AbortController();
        let loadedUrl: string | null = null;
        setObjectUrl(null);
        setError(null);

        void fetchServerArtifact(path, controller.signal)
            .then((blob) => {
                if (controller.signal.aborted) return;
                loadedUrl = URL.createObjectURL(blob);
                setObjectUrl(loadedUrl);
            })
            .catch((loadError) => {
                if (controller.signal.aborted) return;
                setError(
                    loadError instanceof Error ? loadError.message : "Unable to load artifact",
                );
            });

        return () => {
            controller.abort();
            if (loadedUrl) URL.revokeObjectURL(loadedUrl);
        };
    }, [path]);

    if (error) {
        return (
            <div className="placeholder-image artifact-load-error" role="alert">
                {error}
            </div>
        );
    }
    if (!objectUrl) {
        return (
            <output className="placeholder-image" aria-label={`Loading ${name}`}>
                Loading…
            </output>
        );
    }
    return <img src={objectUrl} alt={name} />;
}
