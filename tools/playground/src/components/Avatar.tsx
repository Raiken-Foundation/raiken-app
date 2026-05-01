import type { User } from "../types";

interface AvatarProps {
    user: User;
    size?: "sm" | "md" | "lg";
}

export default function Avatar({ user, size = "md" }: AvatarProps) {
    const initials = user.username.slice(0, 2).toUpperCase();
    return (
        <span
            className={`avatar avatar-${size}`}
            style={{ background: user.avatarColor }}
            title={`${user.username} (${user.role})`}
            data-testid={`avatar-${user.username}`}
        >
            {initials}
        </span>
    );
}
