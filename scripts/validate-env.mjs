#!/usr/bin/env node
import {
  mergedEnv,
  readEnvFile,
  requiredEnvReport,
  REQUIRED_ENV_KEYS,
} from "./lib/env.mjs";

const validateExample = process.argv.includes("--example");
const envPath = validateExample ? ".env.example" : ".env";
const env = validateExample ? readEnvFile(envPath) : mergedEnv(envPath);
const report = requiredEnvReport(env, REQUIRED_ENV_KEYS);

if (report.missing.length > 0) {
  console.error(`Missing required environment keys in ${envPath}:`);
  for (const key of report.missing) console.error(`- ${key}`);
  process.exit(1);
}

console.log(`Environment check passed for ${envPath}.`);
