import { formatDate } from "./helpers";
import type { TimelineEventRow } from "./types";

interface TimelineSectionProps {
    events: TimelineEventRow[];
}

export function TimelineSection({ events }: TimelineSectionProps) {
    if (events.length === 0) return null;

    return (
        <section className="card">
            <h2 className="card-title">Activity</h2>
            <div className="timeline">
                {events.map((event) => (
                    <div key={event.id} className="tl-event">
                        <div className="tl-top">
                            <span className="tl-type">{event.type}</span>
                            <time className="tl-time">{formatDate(event.timestamp)}</time>
                        </div>
                        <p className="tl-msg">{event.message}</p>
                    </div>
                ))}
            </div>
        </section>
    );
}
