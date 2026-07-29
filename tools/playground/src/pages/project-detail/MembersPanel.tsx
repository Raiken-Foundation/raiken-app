import { useEffect, useId, useState } from "react";
import { ApiError, addProjectMember, listAllUsers, removeProjectMember } from "../../api";
import Avatar from "../../components/Avatar";
import { useAuth } from "../../contexts/AuthContext";
import { useToast } from "../../contexts/ToastContext";
import type { Project, User } from "../../types";

interface Props {
    project: Project;
    members: User[];
    onChanged: () => Promise<void> | void;
}

export default function MembersPanel({ project, members, onChanged }: Props) {
    const { user, isAdmin } = useAuth();
    const { push } = useToast();
    const selectId = useId();
    const [allUsers, setAllUsers] = useState<User[]>([]);
    const [selectedUserId, setSelectedUserId] = useState("");
    const [busyUserId, setBusyUserId] = useState<string | null>(null);

    useEffect(() => {
        listAllUsers()
            .then(setAllUsers)
            .catch(() => setAllUsers([]));
    }, []);

    const available = allUsers.filter((candidate) => !project.memberIds.includes(candidate.id));
    const addMember = async () => {
        if (!user || !selectedUserId) return;
        setBusyUserId(selectedUserId);
        try {
            await addProjectMember(project.id, selectedUserId, user);
            setSelectedUserId("");
            push("success", "Project member added");
            await onChanged();
        } catch (error) {
            push("error", error instanceof ApiError ? error.message : "Failed to add member");
        } finally {
            setBusyUserId(null);
        }
    };
    const removeMember = async (member: User) => {
        if (!user) return;
        setBusyUserId(member.id);
        try {
            await removeProjectMember(project.id, member.id, user);
            push("success", `${member.username} removed`);
            await onChanged();
        } catch (error) {
            push("error", error instanceof ApiError ? error.message : "Failed to remove member");
        } finally {
            setBusyUserId(null);
        }
    };

    return (
        <div className="members-panel" data-testid="members-panel">
            {isAdmin && project.status !== "archived" && available.length > 0 && (
                <div className="member-manager">
                    <div className="toolbar-field">
                        <label htmlFor={selectId}>Add a project member</label>
                        <select
                            id={selectId}
                            value={selectedUserId}
                            onChange={(event) => setSelectedUserId(event.target.value)}
                            data-testid="member-select"
                        >
                            <option value="">Select a user</option>
                            {available.map((candidate) => (
                                <option key={candidate.id} value={candidate.id}>
                                    {candidate.username}
                                </option>
                            ))}
                        </select>
                    </div>
                    <button
                        type="button"
                        className="btn btn-primary"
                        onClick={addMember}
                        disabled={!selectedUserId || busyUserId !== null}
                        data-testid="member-add"
                    >
                        Add member
                    </button>
                </div>
            )}
            <ul className="member-list">
                {members.map((m) => (
                    <li key={m.id} className="member-row" data-testid={`member-${m.username}`}>
                        <Avatar user={m} />
                        <div className="member-meta">
                            <span className="member-name">{m.username}</span>
                            <span className="member-email">{m.email}</span>
                        </div>
                        <span className={`pill pill-role-${m.role}`}>{m.role}</span>
                        {m.id === project.ownerId && (
                            <span className="badge-owner" data-testid={`owner-${m.username}`}>
                                Owner
                            </span>
                        )}
                        {isAdmin && project.status !== "archived" && m.id !== project.ownerId && (
                            <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={() => removeMember(m)}
                                disabled={busyUserId !== null}
                                data-testid={`member-remove-${m.username}`}
                            >
                                Remove
                            </button>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
}
