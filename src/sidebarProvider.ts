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

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly timerManager: TimerManager,
    private readonly openChatsTracker: OpenChatsTracker,
    private readonly cacheKeepManager: CacheKeepManager,
    private readonly transcriptWatcher: TranscriptWatcher
  ) {
    this.disposables.push(
      timerManager.onDidChange(() => this.sendUpdate())
    );
    this.disposables.push(
      openChatsTracker.onDidChange(() => this.sendUpdate())
    );
    this.disposables.push(
      cacheKeepManager.onDidChange(() => this.sendUpdate())
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

  private sendUpdate(): void {
    if (!this.view) {
      return;
    }

    const ttl = this.timerManager.ttlSeconds;
    const timers = this.timerManager.getAll();
    const openChatIds = this.openChatsTracker.getOrderedOpenIds();
    this.view.webview.postMessage({
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
    });
  }

  private getHtml(): string {
    return sidebarHtml;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
