import * as vscode from "vscode";
import { TimerManager } from "./timerManager";
import { OpenChatsTracker } from "./openChatsTracker";
import { CacheKeepManager } from "./cacheKeepManager";
import { TranscriptWatcher } from "./transcriptWatcher";
import sidebarHtml from "./sidebar.html";

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "cacheTimer.sidebar";

  private view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];
  private lastPayloadJson: string | undefined;
  private pendingUpdate: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly timerManager: TimerManager,
    private readonly openChatsTracker: OpenChatsTracker,
    private readonly cacheKeepManager: CacheKeepManager,
    private readonly transcriptWatcher: TranscriptWatcher
  ) {
    this.disposables.push(
      timerManager.onDidChange(() => this.scheduleUpdate())
    );
    this.disposables.push(
      openChatsTracker.onDidChange(() => this.scheduleUpdate())
    );
    this.disposables.push(
      cacheKeepManager.onDidChange(() => this.scheduleUpdate())
    );
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "openChat" && msg.chatId) {
        await SidebarProvider.openCursorChat(msg.chatId);
      } else if (msg.type === "toggleCacheKeep" && msg.chatId) {
        this.cacheKeepManager.toggleKeep(msg.chatId);
      } else if (msg.type === "resetCacheKeep" && msg.chatId) {
        this.cacheKeepManager.resetKeep(msg.chatId);
      } else if (msg.type === "refresh") {
        await vscode.commands.executeCommand("cacheTimer.refresh");
      }
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });

    // Reset dedupe so the freshly-loaded webview gets the current state even
    // if it's byte-identical to the last post before it was hidden.
    this.lastPayloadJson = undefined;
    this.sendUpdate();
  }

  static async openCursorChat(chatId: string): Promise<void> {
    const strategies: Array<{ cmd: string; args: unknown[] }> = [
      { cmd: "composer.openComposer", args: [chatId] },
      { cmd: "composer.focusComposer", args: [chatId] },
      { cmd: "composer.openChatAsEditor", args: [chatId] },
      { cmd: `workbench.panel.aichat.view.${chatId}.focus`, args: [] },
      { cmd: `workbench.panel.composerChatViewPane.${chatId}.focus`, args: [] },
      { cmd: "composerChatViewPane.focus", args: [chatId] },
    ];
    for (const { cmd, args } of strategies) {
      try {
        await vscode.commands.executeCommand(cmd, ...args);
        return;
      } catch {
        // Command not available, try next
      }
    }
  }

  private getStatusMessage(): string | undefined {
    const status = this.transcriptWatcher.status;
    const dir = this.transcriptWatcher.transcriptDirPath;
    switch (status) {
      case "no_workspace":
        return "Open a workspace folder to start tracking cache timers";
      case "dir_not_found":
        return `Transcript directory not found:\n${dir ?? "unknown"}\n\nStart an AI chat in this workspace to create it.`;
      case "watching":
        return "Watching for AI chat activity...";
      default:
        return undefined;
    }
  }

  /**
   * Coalesce bursty events (timer tick + chat activity + title refresh all in
   * the same JS turn) into a single postMessage per animation frame-ish
   * interval. Also skips posts when the serialized payload is byte-identical
   * to the last one — webviews then don't need to do a full re-render.
   */
  private scheduleUpdate(): void {
    if (this.pendingUpdate) {
      return;
    }
    this.pendingUpdate = setTimeout(() => {
      this.pendingUpdate = undefined;
      this.sendUpdate();
    }, 100);
  }

  private sendUpdate(): void {
    if (!this.view) {
      return;
    }

    const ttl = this.timerManager.ttlSeconds;
    const timers = this.timerManager.getAll();
    const openChatIds = this.openChatsTracker.getOrderedOpenIds();
    const payload = {
      type: "update",
      ttl,
      openChatIds,
      statusMessage: this.getStatusMessage(),
      timers: timers.map((t) => ({
        id: t.id,
        title: t.title,
        remainingSeconds: t.remainingSeconds,
        isExpired: t.isExpired,
        lastAssistantTime: t.lastAssistantTime,
        isStreaming: this.timerManager.isStreaming(t.id),
        cacheKeep: this.cacheKeepManager.getKeepInfo(t.id) ?? null,
      })),
    };

    const json = JSON.stringify(payload);
    if (json === this.lastPayloadJson) {
      return;
    }
    this.lastPayloadJson = json;
    this.view.webview.postMessage(payload);
  }

  private getHtml(): string {
    return sidebarHtml;
  }

  dispose(): void {
    if (this.pendingUpdate) {
      clearTimeout(this.pendingUpdate);
      this.pendingUpdate = undefined;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
