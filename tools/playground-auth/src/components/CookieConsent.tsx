import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "playground-auth-cookie-consent";

export default function CookieConsent() {
    const [visible, setVisible] = useState(false);
    const acceptRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (!stored) setVisible(true);
    }, []);

    useEffect(() => {
        if (visible) acceptRef.current?.focus();
    }, [visible]);

    const persist = (choice: "accepted" | "declined") => {
        localStorage.setItem(STORAGE_KEY, choice);
        setVisible(false);
    };

    if (!visible) return null;

    return (
        <div
            className="cookie-banner"
            role="dialog"
            aria-labelledby="cookie-banner-title"
            aria-describedby="cookie-banner-desc"
            data-testid="cookie-consent-banner"
        >
            <div className="cookie-banner-content">
                <p id="cookie-banner-title" className="cookie-banner-title">
                    Cookie preferences
                </p>
                <p id="cookie-banner-desc" className="cookie-banner-desc">
                    This fixture uses cookies for deterministic auth sessions. Choose Accept or
                    Decline — both dismiss this banner for future visits.
                </p>
                <div className="cookie-banner-actions">
                    <button
                        ref={acceptRef}
                        type="button"
                        className="btn-primary cookie-banner-btn"
                        data-testid="cookie-consent-accept"
                        onClick={() => persist("accepted")}
                    >
                        Accept
                    </button>
                    <button
                        type="button"
                        className="btn-secondary cookie-banner-btn"
                        data-testid="cookie-consent-decline"
                        onClick={() => persist("declined")}
                    >
                        Decline
                    </button>
                </div>
            </div>
        </div>
    );
}
