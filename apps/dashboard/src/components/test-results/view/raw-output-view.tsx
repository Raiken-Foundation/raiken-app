export function RawOutputView({ rawOutput }: { rawOutput: string }) {
    return (
        <div className="raw-output">
            <pre>{rawOutput}</pre>
        </div>
    );
}
