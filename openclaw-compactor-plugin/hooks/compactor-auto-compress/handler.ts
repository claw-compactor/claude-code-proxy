/**
 * OpenClaw Compactor — PostToolUse auto-compression hook.
 *
 * Listens for message:sent events and runs compression on files
 * that were recently written or edited by the agent.
 *
 * This handler delegates to the Python compress.py script for actual
 * compression work, keeping the TypeScript layer thin.
 */

import { execSync } from "child_process";
import { resolve, dirname } from "path";
import { existsSync } from "fs";

// Resolve plugin directory relative to this handler
const PLUGIN_DIR = resolve(dirname(dirname(__dirname)));
const COMPRESS_SCRIPT = resolve(PLUGIN_DIR, "compress.py");

// Track recently written files to compress after tool completion
// This is a simple in-memory cache; entries expire after 5 seconds
const recentWrites: Map<string, number> = new Map();

/**
 * Extract file path from a tool call context embedded in message content.
 * The message:sent event includes the tool result content.
 */
function extractFilePaths(content: string): string[] {
  const paths: string[] = [];

  // Match common patterns for file paths in tool results
  // Pattern: "file_path": "/absolute/path/to/file"
  const jsonPattern = /"file_path"\s*:\s*"([^"]+)"/g;
  let match;
  while ((match = jsonPattern.exec(content)) !== null) {
    if (match[1] && match[1].startsWith("/")) {
      paths.push(match[1]);
    }
  }

  // Pattern: "notebook_path": "/absolute/path/to/file"
  const nbPattern = /"notebook_path"\s*:\s*"([^"]+)"/g;
  while ((match = nbPattern.exec(content)) !== null) {
    if (match[1] && match[1].startsWith("/")) {
      paths.push(match[1]);
    }
  }

  // Pattern: file paths mentioned after "successfully" or "written to"
  const successPattern = /(?:written to|created|updated|saved)\s+(?:at\s+)?[`"]?(\/.+?\.[a-z]{1,5})[`"]?/gi;
  while ((match = successPattern.exec(content)) !== null) {
    if (match[1]) {
      paths.push(match[1]);
    }
  }

  return [...new Set(paths)]; // deduplicate
}

/**
 * Run compression on a single file using the Python script.
 * Returns quickly (< 2 seconds) — uses lightweight compression only.
 */
function compressFile(filePath: string): string | null {
  if (!existsSync(COMPRESS_SCRIPT)) {
    return null;
  }

  try {
    const result = execSync(
      `python3 "${COMPRESS_SCRIPT}" auto --changed-file "${filePath}" --quiet --json`,
      {
        timeout: 2000, // Hard 2-second timeout
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    return result.trim();
  } catch {
    // Compression failure should never block the agent
    return null;
  }
}

/**
 * Main hook handler.
 *
 * Fires on message:sent events. Checks if the message content
 * references file writes/edits and triggers compression.
 */
const handler = async (event: {
  type: string;
  action: string;
  sessionKey: string;
  timestamp: Date;
  messages: string[];
  context: {
    to?: string;
    content?: string;
    success?: boolean;
    channelId?: string;
  };
}) => {
  // Only handle successful message:sent events
  if (event.type !== "message" || event.action !== "sent") {
    return;
  }

  if (!event.context?.success || !event.context?.content) {
    return;
  }

  const content = event.context.content;

  // Check if the content mentions file write/edit operations
  const hasWriteIndicator =
    content.includes("Write") ||
    content.includes("Edit") ||
    content.includes("file_path") ||
    content.includes("written") ||
    content.includes("created successfully");

  if (!hasWriteIndicator) {
    return;
  }

  // Extract file paths from the message content
  const filePaths = extractFilePaths(content);
  if (filePaths.length === 0) {
    return;
  }

  // Compress each file (fire and forget — don't block)
  for (const fp of filePaths) {
    try {
      const result = compressFile(fp);
      if (result) {
        const parsed = JSON.parse(result);
        if (parsed.action === "compressed" && parsed.tokens_saved > 0) {
          console.log(
            `[compactor] ${fp.split("/").pop()}: -${parsed.tokens_saved} tokens (${parsed.savings_pct}% saved)`
          );
        }
      }
    } catch {
      // Silently ignore errors — hook must never block agent workflow
    }
  }
};

export default handler;
