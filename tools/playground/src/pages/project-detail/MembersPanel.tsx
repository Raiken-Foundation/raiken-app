import Avatar from "../../components/Avatar";
import type { User } from "../../types";

interface Props {
    members: User[];
    owner: string;
}

export default function MembersPanel({ members, owner }: Props) {
    return (
        <div className="members-panel" data-testid="members-panel">
            <ul className="member-list">
                {members.map((m) => (
                    <li key={m.id} className="member-row" data-testid={`member-${m.username}`}>
                        <Avatar user={m} />
                        <div className="member-meta">
                            <span className="member-name">{m.username}</span>
                            <span className="member-email">{m.email}</span>
                        </div>
                        <span className={`pill pill-role-${m.role}`}>{m.role}</span>
                        {m.id === owner && (
                            <span className="badge-owner" data-testid={`owner-${m.username}`}>
                                Owner
                            </span>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
}
