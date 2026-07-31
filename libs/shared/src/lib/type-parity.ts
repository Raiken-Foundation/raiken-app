/** Compile-time helpers for proving transport types match canonical core shapes. */
export type AssertExact<A, B> =
    (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : never;

export type AssertMutuallyExact<A, B> = AssertExact<A, B>;

/** Fails compilation when `T` is not exactly `true`. */
export type ExpectTrue<T extends true> = T;
