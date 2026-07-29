import nx from "@nx/eslint-plugin";
import tseslint from "typescript-eslint";

export default [
    {
        ignores: ["**/dist/**", "**/node_modules/**", "**/out-tsc/**"],
    },
    {
        files: ["apps/**/*.{ts,tsx,js,jsx}", "libs/**/*.{ts,tsx,js,jsx}"],
        linterOptions: {
            reportUnusedDisableDirectives: false,
        },
        languageOptions: {
            parser: tseslint.parser,
        },
        plugins: {
            "@nx": nx,
            "@typescript-eslint": tseslint.plugin,
        },
        rules: {
            "@nx/enforce-module-boundaries": [
                "error",
                {
                    enforceBuildableLibDependency: true,
                    checkDynamicDependenciesExceptions: ["@raiken/core"],
                    depConstraints: [
                        {
                            sourceTag: "scope:dashboard",
                            onlyDependOnLibsWithTags: ["scope:shared"],
                        },
                        {
                            sourceTag: "scope:shared",
                            onlyDependOnLibsWithTags: ["scope:core"],
                        },
                        {
                            sourceTag: "scope:cli",
                            onlyDependOnLibsWithTags: ["scope:shared", "scope:core"],
                        },
                        {
                            sourceTag: "scope:core",
                            onlyDependOnLibsWithTags: [],
                        },
                    ],
                },
            ],
        },
    },
];
