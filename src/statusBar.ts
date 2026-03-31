import * as vscode from "vscode";
import { TimerManager, ChatTimer } from "./timerManager";
import { OpenChatsTracker } from "./openChatsTracker";

const BASE_PRIORITY = 100;

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

      const truncatedTitle =
        timer.title.length > 20
          ? timer.title.slice(0, 17) + "..."
          : timer.title;

      if (timer.isExpired) {
        item.text = `$(clock) ${truncatedTitle}: expired`;
        item.tooltip = `"${timer.title}" — cache expired\nClick to open chat`;
        item.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.errorBackground"
        );
      } else {
        const minutes = Math.floor(timer.remainingSeconds / 60);
        const seconds = timer.remainingSeconds % 60;
        const display = `${minutes}:${seconds.toString().padStart(2, "0")}`;
        item.text = `$(clock) ${truncatedTitle}: ${display}`;
        item.tooltip = `"${timer.title}" — ${display} remaining\nClick to open chat`;

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
