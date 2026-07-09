#!/usr/bin/env node
import {
  buildInboxClassifierDebug,
  formatInboxClassifierDebug,
  parseInboxClassifierDebugArgs,
} from "./lib/inbox-classifier-debug.mjs";

async function readStdin() {
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8").trim();
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    const parsed = parseInboxClassifierDebugArgs(process.argv.slice(2));
    const message = parsed.message || await readStdin();

    if (!message) {
      throw new Error('Usage: npm run inbox:debug -- "Can you book golf tomorrow morning?"');
    }

    const result = buildInboxClassifierDebug({
      message,
      actionOptions: parsed.actionOptions,
    });
    console.log(parsed.json ? JSON.stringify(result, null, 2) : formatInboxClassifierDebug(result));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
