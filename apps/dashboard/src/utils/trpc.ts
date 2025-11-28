// CLEAN IMPORT - NO RELATIVE PATHS
import type { AppRouter } from "@raiken/api";
import { createTRPCReact } from "@trpc/react-query";

export const trpc = createTRPCReact<AppRouter>();
