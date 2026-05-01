// Small standalone helpers reused by pages and tests.
//
// Functions here are deliberately pure so unit tests (and `raiken cover`)
// can reason about them without spinning up React.

export const validateEmail = (email: string): boolean => {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
};

export const validateUsername = (username: string): boolean => {
    return username.length >= 3 && username.length <= 20;
};

export const slugify = (input: string): string =>
    input
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);

export const formatDate = (input: string | Date): string => {
    const date = typeof input === "string" ? new Date(input) : input;
    return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
    }).format(date);
};

export const sum = (a: number, b: number): number => a + b;
