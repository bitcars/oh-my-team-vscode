/**
 * Test-only preload: replaces the Telegram adapter with a no-network stub.
 *
 *   bun --preload <this file> run router.ts
 *
 * bin/omt adds the --preload only through the OMT_ROUTER_PRELOAD test seam,
 * which it honours only inside an OMT_TEST_SANDBOX (see bin/omt-profile.sh).
 * Self-contained on purpose (no relative imports): the test harness copies
 * it into the sandbox.
 *
 * The stub never touches the network: threads get synthetic ids, and sends
 * are written to stderr (the router's pane log).
 */

let counter = 0;

class StubTelegramAdapter {
  readonly name = "telegram";
  botCommands = undefined;
  private messageCallback: ((message: unknown) => void) | null = null;

  async connect(): Promise<void> {
    process.stderr.write("stub-adapter: connected (no network)\n");
  }
  async disconnect(): Promise<void> {}
  async createThread(sessionName: string) {
    counter += 1;
    return { threadId: `stub-thread-${sessionName}-${counter}`, displayName: sessionName };
  }
  async closeThread(): Promise<void> {}
  async send(threadId: string, text: string): Promise<void> {
    process.stderr.write(`stub-adapter: send ${threadId}: ${text.slice(0, 120)}\n`);
  }
  async sendPermissionPrompt(): Promise<void> {}
  onMessage(cb: (message: unknown) => void): void {
    this.messageCallback = cb;
  }
  onPermissionResponse(): void {}
  getHubThreadId(): string | null {
    return null;
  }
}

Bun.plugin({
  name: "omt-test-stub-telegram-adapter",
  setup(build) {
    build.onLoad({ filter: /[\\/]adapters[\\/]telegram\.ts$/ }, () => ({
      exports: { TelegramAdapter: StubTelegramAdapter },
      loader: "object",
    }));
  },
});
