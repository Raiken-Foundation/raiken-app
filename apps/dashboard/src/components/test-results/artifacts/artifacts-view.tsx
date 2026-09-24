import type { CategorizedArtifact, CategorizedArtifacts } from "../types";
import { AuthenticatedArtifactImage } from "./authenticated-artifact-image";
import { AuthenticatedArtifactLink } from "./authenticated-artifact-link";
import { statusBucket } from "../model/report-model";

function ArtifactListItem({
    artifact,
    kind,
    actionLabel,
}: {
    artifact: CategorizedArtifact;
    kind: "video" | "trace" | "other";
    actionLabel: string;
}) {
    return (
        <div className={`artifact-item ${kind} ${statusBucket(artifact.testStatus)}`}>
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                {kind === "video" ? (
                    <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                ) : kind === "trace" ? (
                    <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                ) : (
                    <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                )}
            </svg>
            <div className="item-info">
                <span className="item-name">{artifact.name}</span>
                <span className="item-test">{artifact.testName}</span>
            </div>
            {kind === "other" && artifact.contentType ? (
                <span className="item-type">{artifact.contentType}</span>
            ) : null}
            {artifact.path ? (
                <AuthenticatedArtifactLink
                    path={artifact.path}
                    label={actionLabel}
                    fileName={artifact.name}
                />
            ) : null}
        </div>
    );
}

export function ArtifactsView({ artifacts }: { artifacts: CategorizedArtifacts }) {
    if (artifacts.all.length === 0) {
        return (
            <div className="no-artifacts">
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <h3>No Artifacts Available</h3>
                <p>Run tests with screenshot/video capture enabled to see artifacts here.</p>
                <div className="artifact-tips">
                    <h4>Enable in playwright.config.ts:</h4>
                    <pre>{`use: {
  screenshot: 'only-on-failure',
  video: 'retain-on-failure',
  trace: 'retain-on-failure',
}`}</pre>
                </div>
            </div>
        );
    }

    return (
        <div className="artifacts-content">
            {artifacts.screenshots.length > 0 && (
                <div className="artifact-section">
                    <h4>
                        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                        Screenshots ({artifacts.screenshots.length})
                    </h4>
                    <div className="artifact-grid">
                        {artifacts.screenshots.map((screenshot, index) => (
                            <div
                                key={`${screenshot.name}-${index}`}
                                className={`artifact-card ${statusBucket(screenshot.testStatus)}`}
                            >
                                <div className="artifact-preview">
                                    {screenshot.path ? (
                                        <AuthenticatedArtifactImage
                                            path={screenshot.path}
                                            name={screenshot.name}
                                        />
                                    ) : (
                                        <div className="placeholder-image">
                                            <svg
                                                aria-hidden="true"
                                                viewBox="0 0 24 24"
                                                fill="none"
                                                stroke="currentColor"
                                                strokeWidth="1.5"
                                            >
                                                <path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                            </svg>
                                        </div>
                                    )}
                                </div>
                                <div className="artifact-info">
                                    <span className="artifact-name">{screenshot.name}</span>
                                    <span className="artifact-test">{screenshot.testName}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {artifacts.videos.length > 0 && (
                <div className="artifact-section">
                    <h4>
                        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                        Videos ({artifacts.videos.length})
                    </h4>
                    <div className="artifact-list">
                        {artifacts.videos.map((video, index) => (
                            <ArtifactListItem
                                key={`${video.name}-${index}`}
                                artifact={video}
                                kind="video"
                                actionLabel="View"
                            />
                        ))}
                    </div>
                </div>
            )}

            {artifacts.traces.length > 0 && (
                <div className="artifact-section">
                    <h4>
                        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                        </svg>
                        Traces ({artifacts.traces.length})
                    </h4>
                    <div className="artifact-list">
                        {artifacts.traces.map((trace, index) => (
                            <ArtifactListItem
                                key={`${trace.name}-${index}`}
                                artifact={trace}
                                kind="trace"
                                actionLabel="Open Trace"
                            />
                        ))}
                    </div>
                </div>
            )}

            {artifacts.other.length > 0 && (
                <div className="artifact-section">
                    <h4>
                        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        Other Files ({artifacts.other.length})
                    </h4>
                    <div className="artifact-list">
                        {artifacts.other.map((file, index) => (
                            <ArtifactListItem
                                key={`${file.name}-${index}`}
                                artifact={file}
                                kind="other"
                                actionLabel="Open"
                            />
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
