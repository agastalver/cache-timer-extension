import * as vscode from "vscode";
import { TimerManager } from "./timerManager";

const KEEP_THRESHOLD_SECONDS = 30;

interface KeepSession {
  chatId: string;
  startedAt: number;
  durationTimeout: ReturnType<typeof setTimeout>;
  pendingPing: boolean;
}

export class CacheKeepManager implements vscode.Disposable {
  private sessions = new Map<string, KeepSession>();
  private disposables: vscode.Disposable[] = [];
  private readonly log: vscode.OutputChannel;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  static readonly KEEP_MESSAGE =
    'just say "hi" now to keep the cache active; ignore this afterwards';

  get durationSeconds(): number {
    return vscode.workspace
      .getConfiguration("cacheTimer")
      .get<number>("cacheKeepDurationSeconds", 1800);
  }

  constructor(private readonly timerManager: TimerManager) {
    this.log = vscode.window.createOutputChannel("Cache Timer");
    this.disposables.push(this.log);
    this.disposables.push(
      timerManager.onDidChange(() => this.checkTimers())
    );
  }

  isKeeping(chatId: string): boolean {
    return this.sessions.has(chatId);
  }

  getKeepInfo(chatId: string): { remainingSeconds: number } | undefined {
    const session = this.sessions.get(chatId);
    if (!session) {
      return undefined;
    }
    const elapsed = (Date.now() - session.startedAt) / 1000;
    const remaining = Math.max(0, this.durationSeconds - elapsed);
    return { remainingSeconds: Math.floor(remaining) };
  }

  startKeep(chatId: string): void {
    if (this.sessions.has(chatId)) {
      return;
    }

    const durationMs = this.durationSeconds * 1000;

    const durationTimeout = setTimeout(() => {
      this.stopKeep(chatId);
    }, durationMs);

    this.sessions.set(chatId, {
      chatId,
      startedAt: Date.now(),
      durationTimeout,
      pendingPing: false,
    });

    this._onDidChange.fire();
  }

  stopKeep(chatId: string): void {
    const session = this.sessions.get(chatId);
    if (!session) {
      return;
    }

    clearTimeout(session.durationTimeout);
    this.sessions.delete(chatId);
    this._onDidChange.fire();
  }

  resetKeep(chatId: string): void {
    const session = this.sessions.get(chatId);
    if (!session) {
      return;
    }

    clearTimeout(session.durationTimeout);
    const durationMs = this.durationSeconds * 1000;

    session.startedAt = Date.now();
    session.durationTimeout = setTimeout(() => {
      this.stopKeep(chatId);
    }, durationMs);

    this._onDidChange.fire();
  }

  toggleKeep(chatId: string): void {
    if (this.isKeeping(chatId)) {
      this.stopKeep(chatId);
    } else {
      this.startKeep(chatId);
    }
  }

  private checkTimers(): void {
    for (const session of this.sessions.values()) {
      const timers = this.timerManager.getAll();
      const timer = timers.find((t) => t.id === session.chatId);
      if (!timer) {
        continue;
      }

      if (timer.remainingSeconds > KEEP_THRESHOLD_SECONDS) {
        session.pendingPing = false;
        continue;
      }

      if (
        !session.pendingPing &&
        !timer.isExpired &&
        timer.remainingSeconds <= KEEP_THRESHOLD_SECONDS
      ) {
        session.pendingPing = true;
        this.sendKeepAlive(session.chatId);
      }
    }
  }

  private async sendKeepAlive(chatId: string): Promise<void> {
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    this.log.appendLine(`[KeepAlive] Attempting send for chat ${chatId}`);

    try {
      await vscode.commands.executeCommand("cacheTimer.openChat", chatId);
      this.log.appendLine("[KeepAlive] Opened chat, waiting for focus...");
      await delay(800);

      await vscode.env.clipboard.writeText(CacheKeepManager.KEEP_MESSAGE);
      this.log.appendLine("[KeepAlive] Clipboard written");

      try {
        await vscode.commands.executeCommand(
          "editor.action.clipboardPasteAction"
        );
        this.log.appendLine("[KeepAlive] clipboardPasteAction executed");
      } catch {
        this.log.appendLine("[KeepAlive] clipboardPasteAction failed");
      }

      await delay(300);

      const timer = this.timerManager.getAll().find((t) => t.id === chatId);
      const title = timer?.title ?? chatId.slice(0, 8);
      vscode.window.showInformationMessage(
        `Keep-alive ready for "${title}" — press Enter to send`
      );
      this.log.appendLine("[KeepAlive] Notification shown, waiting for user");
    } catch (err) {
      this.log.appendLine(
        `[KeepAlive] sendKeepAlive failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      clearTimeout(session.durationTimeout);
    }
    this.sessions.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChange.dispose();
  }
}
