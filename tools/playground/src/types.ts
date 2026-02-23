export interface Todo {
    id: string;
    text: string;
    completed: boolean;
    createdAt: Date;
}

export interface User {
    username: string;
    email?: string;
}

export type TodoFilter = "all" | "active" | "completed";

export interface NavItem {
    path: string;
    label: string;
    icon: string;
    requiresAuth: boolean;
}

export interface ProfileData {
    username: string;
    email: string;
    bio: string;
    theme: "light" | "dark";
    notifications: boolean;
}

export interface ContactMessage {
    name: string;
    email: string;
    subject: string;
    message: string;
}