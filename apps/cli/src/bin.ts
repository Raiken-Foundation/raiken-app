#!/usr/bin/env node
import dotenv from "dotenv";
import path from "path";
import chalk from "chalk";
import { Command } from "commander";
import { startServer } from "./server";

// Find project root (go up from dist/apps/cli/bin.cjs to project root)
// dist/apps/cli -> ../../../ = project root
const projectRoot = path.resolve(__dirname, '..', '..', '..');
const envPath = path.join(projectRoot, '.env');

// Load .env file
const result = dotenv.config({ path: envPath });

if (result.error) {
  console.warn(chalk.yellow('⚠️  Failed to load .env:'), result.error.message);
} 
if (process.env.OPENROUTER_API_KEY) {
  console.log('🔐 API Key length:', process.env.OPENROUTER_API_KEY.length, 'characters');
}

const program = new Command();
program.name("raiken").description("AI QA Agent for Developers").version("0.0.1");

program
    .command("start")
    .description("Start the Raiken Dashboard & Agent")
    .option("-p, --port <number>", "Port to run on", "7101")
    .action((options) => {
        console.log(chalk.cyan("Initializing Raiken..."));
        startServer(parseInt(options.port));
    });

program
    .command("init")
    .description("Initialize Raiken in the current project")
    .option("-f, --force", "Overwrite existing configuration files", false)
    .action(async (options) => {
        try {
            const { initializeProject } = await import("./initializer");
            await initializeProject(process.cwd(), options.force);
        } catch (error) {
            console.error(chalk.red("\n ❌ Failed to initialize project:"), error);
            process.exit(1);
        }
    });

program.parse(process.argv);
