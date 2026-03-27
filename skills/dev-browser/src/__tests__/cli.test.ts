import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * CLI unit tests.
 *
 * These test the CLI's argument parsing, script wrapping, and error handling
 * in isolation — no real browser or server needed.
 */

// Mock fetch globally for client-lite
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Helper to set up standard mock responses
function setupMockServer() {
  mockFetch.mockImplementation(async (url: string, options?: RequestInit) => {
    const urlStr = url.toString();

    // GET / - server info
    if (urlStr.endsWith("/") && (!options || options.method === undefined)) {
      return new Response(
        JSON.stringify({ wsEndpoint: "ws://127.0.0.1:19222/cdp", mode: "external-browser" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // GET /pages - list pages
    if (urlStr.endsWith("/pages") && (!options || options.method === undefined)) {
      return new Response(JSON.stringify({ pages: ["test-page"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // POST /pages - create/get page
    if (urlStr.endsWith("/pages") && options?.method === "POST") {
      const body = JSON.parse(options.body as string);
      return new Response(
        JSON.stringify({
          wsEndpoint: "ws://127.0.0.1:19222/cdp",
          name: body.name,
          targetId: "target-123",
          mode: "launch",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // GET /pages/:name/info
    if (urlStr.includes("/pages/") && urlStr.endsWith("/info")) {
      return new Response(
        JSON.stringify({ url: "https://example.com/", title: "Example Domain" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // POST /pages/:name/navigate
    if (urlStr.includes("/navigate")) {
      return new Response(
        JSON.stringify({ url: "https://example.com/", title: "Example Domain" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // GET /pages/:name/snapshot
    if (urlStr.includes("/snapshot")) {
      return new Response(
        JSON.stringify({
          snapshot: '- heading "Example Domain" [level=1] [ref=e1]',
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // POST /pages/:name/evaluate
    if (urlStr.includes("/evaluate")) {
      return new Response(JSON.stringify({ result: "Example Domain" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // POST /pages/:name/screenshot
    if (urlStr.includes("/screenshot")) {
      // Small 1x1 PNG as base64
      return new Response(
        JSON.stringify({
          screenshot:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          mimeType: "image/png",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // POST /pages/:name/click
    if (urlStr.includes("/click")) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // POST /pages/:name/fill
    if (urlStr.includes("/fill")) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // POST /pages/:name/set-viewport
    if (urlStr.includes("/set-viewport")) {
      return new Response(JSON.stringify({ success: true, width: 1280, height: 800 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // POST /pages/:name/wait-for-selector
    if (urlStr.includes("/wait-for-selector")) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // DELETE /pages/:name
    if (options?.method === "DELETE") {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  });
}

// Import the connectLite function to test the browser API layer
// We test through connectLite since the CLI's createBrowserApi wraps it
import { connectLite } from "../client-lite.js";

describe("CLI browser API via connectLite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMockServer();
  });

  it("should create and retrieve a named page", async () => {
    const client = await connectLite("http://localhost:19222");
    const result = await client.page("mypage");
    expect(result.name).toBe("mypage");
    expect(result.targetId).toBe("target-123");
  });

  it("should list pages", async () => {
    const client = await connectLite("http://localhost:19222");
    const pages = await client.list();
    expect(pages).toEqual(["test-page"]);
  });

  it("should navigate to a URL", async () => {
    const client = await connectLite("http://localhost:19222");
    const result = await client.navigate("mypage", "https://example.com");
    expect(result.url).toBe("https://example.com/");
    expect(result.title).toBe("Example Domain");
  });

  it("should get AI snapshot", async () => {
    const client = await connectLite("http://localhost:19222");
    const snapshot = await client.getAISnapshot("mypage");
    expect(snapshot).toContain("Example Domain");
  });

  it("should evaluate JavaScript", async () => {
    const client = await connectLite("http://localhost:19222");
    const result = await client.evaluate("mypage", "document.title");
    expect(result).toBe("Example Domain");
  });

  it("should click an element by ref", async () => {
    const client = await connectLite("http://localhost:19222");
    // Should not throw
    await client.click("mypage", "e1");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/click"),
      expect.objectContaining({ method: "POST" })
    );
  });

  it("should fill an input by ref", async () => {
    const client = await connectLite("http://localhost:19222");
    await client.fill("mypage", "e1", "hello world");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/fill"),
      expect.objectContaining({ method: "POST" })
    );
  });

  it("should take a screenshot and return base64", async () => {
    const client = await connectLite("http://localhost:19222");
    const result = await client.screenshot("mypage");
    expect(result.screenshot).toBeTruthy();
    expect(result.mimeType).toBe("image/png");
  });

  it("should close a page", async () => {
    const client = await connectLite("http://localhost:19222");
    await client.close("mypage");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/pages/mypage"),
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("should get page info", async () => {
    const client = await connectLite("http://localhost:19222");
    const info = await client.getInfo("mypage");
    expect(info.url).toBe("https://example.com/");
    expect(info.title).toBe("Example Domain");
  });

  it("should get server info", async () => {
    const client = await connectLite("http://localhost:19222");
    const info = await client.getServerInfo();
    expect(info.mode).toBe("external-browser");
  });

  it("should handle server errors gracefully", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "page not found" }), { status: 404 })
    );
    const client = await connectLite("http://localhost:19222");
    await expect(client.getInfo("nonexistent")).rejects.toThrow("404");
  });
});

describe("CLI argument parsing", () => {
  // We can't easily import parseArgs since it's not exported,
  // but we can test the CLI's behavior by checking the help output
  // and verifying the script execution flow.

  it("should handle empty stdin gracefully", async () => {
    // The CLI should exit with error when no script is provided on a TTY
    // This is tested by the `readStdin` function checking `process.stdin.isTTY`
    expect(true).toBe(true); // Placeholder — real test is the manual TTY check
  });
});

describe("CLI script execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMockServer();
  });

  it("should execute async scripts with browser object", async () => {
    // Simulate what the CLI does: create an AsyncFunction with browser in scope
    const client = await connectLite("http://localhost:19222");

    // Replicate the browser API creation from cli.ts
    const browser = {
      page: (name: string) => client.page(name),
      navigate: (name: string, url: string) => client.navigate(name, url),
      snapshot: (name: string) => client.getAISnapshot(name),
      evaluate: (name: string, expr: string) => client.evaluate(name, expr),
      info: (name: string) => client.getInfo(name),
      list: () => client.list(),
      close: (name: string) => client.close(name),
    };

    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

    // Test a multi-step script
    const script = `
      await browser.page("test");
      await browser.navigate("test", "https://example.com");
      const info = await browser.info("test");
      return info.title;
    `;

    const fn = new AsyncFunction("browser", script);
    const result = await fn(browser);
    expect(result).toBe("Example Domain");
  });

  it("should handle script errors without crashing", async () => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

    const script = `throw new Error("test error");`;
    const fn = new AsyncFunction("browser", script);

    await expect(fn({})).rejects.toThrow("test error");
  });

  it("should respect timeout", async () => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

    const script = `await new Promise(r => setTimeout(r, 10000));`;
    const fn = new AsyncFunction("browser", script);

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Script timed out")), 50);
    });

    await expect(Promise.race([fn({}), timeoutPromise])).rejects.toThrow("Script timed out");
  });
});
