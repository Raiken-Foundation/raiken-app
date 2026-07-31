export class DatabaseError extends Error {
    constructor(
        message: string,
        public override readonly cause?: Error,
    ) {
        super(message);
        this.name = "DatabaseError";
    }
}
