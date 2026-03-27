#!/usr/bin/env node
/**
 * dev-browser CLI - Execute browser automation scripts via stdin.
 *
 * Reads a script from stdin (heredoc pattern), wraps it with a `browser`
 * object backed by the connectLite() HTTP client, and executes it directly.
 * No sandbox, no Rust, no tsx overhead — just Node.js + your existing server.
 *
 * Usage:
 *   dev-browser run <<'SCRIPT'
 *   await browser.navigate("mypage", "http://localhost:3000");
 *   const snapshot = await browser.snapshot("mypage");
 *   console.log(snapshot);
 *   SCRIPT
 *
 *   dev-browser run --timeout 60000 <<'SCRIPT'
 *   // long-running script
 *   SCRIPT
 *
 *   dev-browser status     # show server status
 *   dev-browser pages      # list active pages
 */

import { connectLite, type DevBrowserLiteClient } from "./client-lite.js";
import { getMostRecentServer, loadConfig, getActiveServerCount } from "./config.js";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = join(__dirname, "..", "tmp");

// ============================================================================
// CLI Argument Parsing
// ============================================================================

interface CliArgs {
  command: "run" | "status" | "pages" | "help";
  timeout: number;
  serverUrl?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2); // skip node and script path
  let command: CliArgs["command"] = "run";
  let timeout = 30000;
  let serverUrl: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "run" || arg === "status" || arg === "pages" || arg === "help") {
      command = arg;
    } else if (arg === "--timeout" && args[i + 1]) {
      timeout = parseInt(args[i + 1]!, 10);
      i++;
    } else if (arg === "--server" && args[i + 1]) {
      serverUrl = args[i + 1];
      i++;
    } else if (arg === "--help" || arg === "-h") {
      command = "help";
    }
  }

  return { command, timeout, serverUrl };
}

// ============================================================================
// Script Reading
// ============================================================================

async function readStdin(): Promise<string> {
  // Check if stdin is a TTY (no piped input)
  if (process.stdin.isTTY) {
    return "";
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

// ============================================================================
// Script Execution
// ============================================================================

/**
 * Create the `browser` API object that scripts use.
 * This is a thin wrapper around connectLite that provides a more ergonomic API
 * for scripts — matching the patterns agents naturally want to write.
 */
function createBrowserApi(client: DevBrowserLiteClient) {
  return {
    /**
     * Get or create a named page.
     * @example await browser.page("checkout")
     */
    page: (name: string) => client.page(name),

    /**
     * Navigate a page to a URL.
     * @example await browser.navigate("checkout", "http://localhost:3000/checkout")
     */
    navigate: async (
      name: string,
      url: string,
      waitUntil?: "load" | "domcontentloaded" | "networkidle"
    ) => {
      const result = await client.navigate(name, url, waitUntil);
      return result;
    },

    /**
     * Get AI-friendly ARIA snapshot.
     * @example const snapshot = await browser.snapshot("checkout")
     */
    snapshot: (name: string) => client.getAISnapshot(name),

    /**
     * Evaluate JavaScript in the browser context.
     * @example const title = await browser.evaluate("checkout", "document.title")
     */
    evaluate: (name: string, expression: string) => client.evaluate(name, expression),

    /**
     * Click an element by snapshot ref.
     * @example await browser.click("checkout", "e5")
     */
    click: (name: string, ref: string) => client.click(name, ref),

    /**
     * Fill an input by snapshot ref.
     * @example await browser.fill("checkout", "e10", "test@example.com")
     */
    fill: (name: string, ref: string, value: string) => client.fill(name, ref, value),

    /**
     * Get element info by snapshot ref.
     * @example const info = await browser.selectRef("checkout", "e5")
     */
    selectRef: (name: string, ref: string) => client.selectRef(name, ref),

    /**
     * Take a screenshot and save to tmp/.
     * Returns the file path.
     * @example const path = await browser.screenshot("checkout")
     * @example const path = await browser.screenshot("checkout", { fullPage: true })
     */
    screenshot: async (
      name: string,
      options?: { fullPage?: boolean; selector?: string; filename?: string }
    ): Promise<string> => {
      const result = await client.screenshot(name, {
        fullPage: options?.fullPage,
        selector: options?.selector,
      });
      const filename = options?.filename || `screenshot-${Date.now()}.png`;
      const filepath = join(TMP_DIR, filename);
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(filepath, Buffer.from(result.screenshot, "base64"));
      return filepath;
    },

    /**
     * Set viewport size.
     * @example await browser.setViewport("checkout", 1280, 800)
     */
    setViewport: (name: string, width: number, height: number) =>
      client.setViewportSize(name, width, height),

    /**
     * Wait for a selector to appear.
     * @example await browser.waitFor("checkout", ".results")
     */
    waitFor: (
      name: string,
      selector: string,
      options?: { timeout?: number; state?: "attached" | "detached" | "visible" | "hidden" }
    ) => client.waitForSelector(name, selector, options),

    /**
     * Get page URL and title.
     * @example const { url, title } = await browser.info("checkout")
     */
    info: (name: string) => client.getInfo(name),

    /**
     * List all named pages.
     * @example const pages = await browser.list()
     */
    list: () => client.list(),

    /**
     * Close a named page.
     * @example await browser.close("checkout")
     */
    close: (name: string) => client.close(name),

    /**
     * Get server info (mode, extension status).
     */
    serverInfo: () => client.getServerInfo(),
  };
}

async function executeScript(script: string, args: CliArgs): Promise<void> {
  const client = await connectLite(args.serverUrl);
  const browser = createBrowserApi(client);

  // Build an async function from the script with `browser` in scope
  // We use AsyncFunction constructor to allow top-level await
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const fn = new AsyncFunction(
      "browser",
      "console",
      "Buffer",
      "writeFileSync",
      "mkdirSync",
      "join",
      "TMP_DIR",
      script
    );

    // Set up timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Script timed out after ${args.timeout}ms`));
      }, args.timeout);
    });

    // Execute with racing timeout
    await Promise.race([
      fn(browser, console, Buffer, writeFileSync, mkdirSync, join, TMP_DIR),
      timeoutPromise,
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    await client.disconnect();
  }
}

// ============================================================================
// Commands
// ============================================================================

async function cmdStatus(): Promise<void> {
  const config = loadConfig();
  const serverCount = getActiveServerCount();
  const recent = getMostRecentServer();

  console.log("dev-browser status");
  console.log("==================");
  console.log(`Active servers: ${serverCount}`);
  console.log(`Port range: ${config.portRange.start}-${config.portRange.end}`);
  console.log(`CDP port: ${config.cdpPort}`);
  console.log(`Browser mode: ${config.browser.mode}`);
  if (config.browser.path) {
    console.log(`Browser path: ${config.browser.path}`);
  }
  if (recent) {
    console.log(`\nMost recent server:`);
    console.log(`  Port: ${recent.port}`);
    console.log(`  PID: ${recent.info.pid}`);
    console.log(`  Mode: ${recent.info.mode}`);
    console.log(`  Started: ${recent.info.startedAt}`);
  }
}

async function cmdPages(args: CliArgs): Promise<void> {
  const client = await connectLite(args.serverUrl);
  try {
    const pages = await client.list();
    if (pages.length === 0) {
      console.log("No active pages");
    } else {
      console.log("Active pages:");
      for (const name of pages) {
        const info = await client.getInfo(name);
        console.log(`  ${name}: ${info.url} — ${info.title}`);
      }
    }
  } finally {
    await client.disconnect();
  }
}

function cmdHelp(): void {
  console.log(`dev-browser - Browser automation CLI

Usage:
  dev-browser run [options] <<'SCRIPT'    Execute a script from stdin
  dev-browser status                      Show server status
  dev-browser pages                       List active pages
  dev-browser help                        Show this help

Options:
  --timeout <ms>    Script timeout in milliseconds (default: 30000)
  --server <url>    Server URL (default: auto-discover)

Script API:
  The script receives a \`browser\` object with these methods:

  browser.page(name)                      Get or create a named page
  browser.navigate(name, url, waitUntil?) Navigate to URL
  browser.snapshot(name)                  Get ARIA snapshot for AI
  browser.evaluate(name, expression)      Run JS in browser
  browser.click(name, ref)                Click element by ref
  browser.fill(name, ref, value)          Fill input by ref
  browser.selectRef(name, ref)            Get element info by ref
  browser.screenshot(name, options?)      Take screenshot (saved to tmp/)
  browser.setViewport(name, w, h)         Set viewport size
  browser.waitFor(name, selector, opts?)  Wait for element
  browser.info(name)                      Get page URL and title
  browser.list()                          List all pages
  browser.close(name)                     Close a page
  browser.serverInfo()                    Get server info

  Also available: console, Buffer, writeFileSync, mkdirSync, join, TMP_DIR

Example:
  dev-browser run <<'SCRIPT'
  await browser.page("app");
  await browser.navigate("app", "http://localhost:3000");
  const snap = await browser.snapshot("app");
  console.log(snap);
  SCRIPT
`);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  switch (args.command) {
    case "help":
      cmdHelp();
      break;
    case "status":
      await cmdStatus();
      break;
    case "pages":
      await cmdPages(args);
      break;
    case "run": {
      const script = await readStdin();
      if (!script) {
        console.error("Error: No script provided. Pipe a script via stdin or use a heredoc.");
        console.error("  dev-browser run <<'SCRIPT'");
        console.error('  await browser.navigate("app", "http://localhost:3000");');
        console.error("  SCRIPT");
        process.exit(1);
      }
      await executeScript(script, args);
      break;
    }
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
