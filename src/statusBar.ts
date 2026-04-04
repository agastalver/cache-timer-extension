import * as vscode from "vscode";
import { TimerManager, ChatTimer } from "./timerManager";
import { OpenChatsTracker } from "./openChatsTracker";

const BASE_PRIORITY = 100;

/**
 * Status bar text parses `$(id)` as ThemeIcons and `[text](command:id)` as
 * links. Chat titles that are raw user messages can contain these patterns and
 * would disappear or render as garbled icons/links. Insert zero-width spaces
 * to break `$(` and `[` tokens. Newlines are collapsed to spaces.
 */
function sanitizeStatusBarLabel(raw: string): string {
  let s = raw.replace(/\r\n|\r|\n/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/\$\(/g, "$\u200b(");
  s = s.replace(/\[/g, "\u200b[");
  return s;
}

function truncateForStatusBar(s: string, maxLen: number): string {
  if (s.length <= maxLen) {
    return s;
  }
  return s.slice(0, maxLen - 2) + "..";
}

export class StatusBar implements vscode.Disposable {
  private items = new Map<string, vscode.StatusBarItem>();
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly timerManager: TimerManager,
    private readonly openChatsTracker: OpenChatsTracker
  ) {
    this.disposables.push(
      timerManager.onDidChange(() => this.update())
    );
    this.disposables.push(
      openChatsTracker.onDidChange(() => this.update())
    );
    this.update();
  }

  private update(): void {
    const orderedIds = this.openChatsTracker.getOrderedOpenIds();
    const allTimers = this.timerManager.getAll();
    const timerMap = new Map<string, ChatTimer>();
    for (const t of allTimers) {
      timerMap.set(t.id, t);
    }

    const activeIds = new Set<string>();

    for (let i = 0; i < orderedIds.length; i++) {
      const chatId = orderedIds[i];
      const timer = timerMap.get(chatId);
      if (!timer) {
        continue;
      }

      activeIds.add(chatId);
      let item = this.items.get(chatId);
      if (!item) {
        item = vscode.window.createStatusBarItem(
          vscode.StatusBarAlignment.Right,
          BASE_PRIORITY - i
        );
        item.command = {
          command: "cacheTimer.openChat",
          arguments: [chatId],
          title: "Open Chat",
        };
        this.items.set(chatId, item);
      }

      const labelTitle = truncateForStatusBar(
        sanitizeStatusBarLabel(timer.title),
        20
      );
      const tooltipTitle = sanitizeStatusBarLabel(timer.title);

      const isStreaming = this.timerManager.isStreaming(chatId);

      if (isStreaming) {
        const minutes = Math.floor(timer.remainingSeconds / 60);
        const seconds = timer.remainingSeconds % 60;
        const display = `${minutes}:${seconds.toString().padStart(2, "0")}`;
        item.text = `$(sync~spin) ${labelTitle}: ${display}`;
        item.tooltip = `"${tooltipTitle}" — streaming (${display})\nClick to open chat`;
        item.backgroundColor = undefined;
      } else if (timer.isExpired) {
        item.text = `$(clock) ${labelTitle}: expired`;
        item.tooltip = `"${tooltipTitle}" — cache expired\nClick to open chat`;
        item.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.errorBackground"
        );
      } else {
        const minutes = Math.floor(timer.remainingSeconds / 60);
        const seconds = timer.remainingSeconds % 60;
        const display = `${minutes}:${seconds.toString().padStart(2, "0")}`;
        item.text = `$(clock) ${labelTitle}: ${display}`;
        item.tooltip = `"${tooltipTitle}" — ${display} remaining\nClick to open chat`;

        if (timer.remainingSeconds <= 60) {
          item.backgroundColor = new vscode.ThemeColor(
            "statusBarItem.errorBackground"
          );
        } else if (timer.remainingSeconds <= 180) {
          item.backgroundColor = new vscode.ThemeColor(
            "statusBarItem.warningBackground"
          );
        } else {
          item.backgroundColor = undefined;
        }
      }

      item.show();
    }

    // Dispose items for chats that are no longer open
    for (const [id, item] of this.items) {
      if (!activeIds.has(id)) {
        item.dispose();
        this.items.delete(id);
      }
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    for (const item of this.items.values()) {
      item.dispose();
    }
    this.items.clear();
  }
}
