interface LogoProps {
    /** Pixel size of the rendered glyph (logo is square). Defaults to 14. */
    size?: number;
    /**
     * When `bare` we drop the purple background tile and only render the
     * black bracket-R mark. Useful inside already-tinted UI cells like the
     * status bar. Defaults to `false` (full-tile mark).
     */
    bare?: boolean;
    className?: string;
    title?: string;
}

const FG = "currentColor";

/**
 * Raiken brand mark — the 8-bit `[ R ]` pixel logo, anchored top-left
 * inside its 64×64 grid (~⅓ of the canvas reserved as bottom-right
 * negative space).
 *
 * Rendered as inline SVG so we can size, tint, and crisp-render it at any
 * resolution without shipping multiple raster assets. `image-rendering:
 * pixelated` is set on the wrapper so favicon-sized renders stay sharp on
 * high-DPI displays.
 *
 * For brand-bar/status-bar contexts where the surrounding area is already
 * dark, pass `bare` to drop the purple tile and inherit `currentColor`.
 */
export function Logo({ size = 14, bare = false, className, title = "Raiken" }: LogoProps) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 64 64"
            width={size}
            height={size}
            className={className}
            style={{ imageRendering: "pixelated", display: "block" }}
            role="img"
            aria-label={title}
        >
            <title>{title}</title>
            {!bare && <rect width="64" height="64" fill="#a78bfa" />}
            <g fill={bare ? FG : "#0a0a0a"}>
                <rect x="4" y="4" width="8" height="4" />
                <rect x="4" y="8" width="4" height="28" />
                <rect x="4" y="36" width="8" height="4" />
                <rect x="40" y="4" width="8" height="4" />
                <rect x="44" y="8" width="4" height="28" />
                <rect x="40" y="36" width="8" height="4" />
                <rect x="16" y="12" width="20" height="4" />
                <rect x="16" y="16" width="4" height="4" />
                <rect x="32" y="16" width="4" height="4" />
                <rect x="16" y="20" width="20" height="4" />
                <rect x="16" y="24" width="4" height="4" />
                <rect x="28" y="24" width="4" height="4" />
                <rect x="16" y="28" width="4" height="4" />
                <rect x="32" y="28" width="4" height="4" />
            </g>
        </svg>
    );
}
