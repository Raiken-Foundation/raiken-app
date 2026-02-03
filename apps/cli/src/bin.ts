#!/usr/bin/env node
import dotenv from "dotenv";
import path from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import { startServer } from "./server";

// Load .env from the current working directory (where the user runs raiken)
const projectRoot = process.cwd();
const envPath = path.join(projectRoot, '.env');

// Load .env file
const result = dotenv.config({ path: envPath });

if (result.error) {
  // Only warn if the file doesn't exist - other errors are more serious
  const errorCode = (result.error as NodeJS.ErrnoException).code;
  if (errorCode === 'ENOENT') {
    console.log(chalk.dim('ℹ️  No .env file found in'), chalk.dim(projectRoot));
  } else {
    console.warn(chalk.yellow('⚠️  Failed to load .env:'), result.error.message);
  }
}

if (process.env.OPENROUTER_API_KEY) {
  console.log('🔐 API Key configured:', process.env.OPENROUTER_API_KEY.length, 'characters');
} else {
  console.warn(chalk.yellow('⚠️  OPENROUTER_API_KEY not set. AI features will not work.'));
  console.log(chalk.dim('   Set it in .env or as an environment variable.'));
  console.log(chalk.dim('   Get a key at: https://openrouter.ai/keys'));
}

const program = new Command();
program.name("raiken").description("AI QA Agent for Developers").version("0.0.1");

program
    .command("start")
    .description("Start the Raiken Dashboard & Agent")
    .option("-p, --port <number>", "Port to run on", "7101")
    .action((options) => {
        console.log(chalk.cyan("Initializing Raiken..."));
        startServer(parseInt(options.port, 10));
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
