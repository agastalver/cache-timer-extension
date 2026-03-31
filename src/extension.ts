import * as vscode from "vscode";
import { TimerManager } from "./timerManager";
import { TranscriptWatcher } from "./transcriptWatcher";
import { ChatTitleResolver } from "./chatTitleResolver";
import { StatusBar } from "./statusBar";
import { SidebarProvider } from "./sidebarProvider";
import { OpenChatsTracker } from "./openChatsTracker";

export async function activate(context: vscode.ExtensionContext) {
  const timerManager = new TimerManager();
  const titleResolver = new ChatTitleResolver();
  const transcriptWatcher = new TranscriptWatcher(titleResolver);
  const openChatsTracker = new OpenChatsTracker();
  const statusBar = new StatusBar(timerManager, openChatsTracker);
  const sidebarProvider = new SidebarProvider(
    context.extensionUri,
    timerManager,
    openChatsTracker
  );

  context.subscriptions.push(
    timerManager,
    titleResolver,
    transcriptWatcher,
    openChatsTracker,
    statusBar,
    sidebarProvider
  );

  context.subscriptions.push(
    transcriptWatcher.onAssistantMessage((event) => {
      timerManager.resetTimer(event.chatId, event.title, event.timestamp);
    })
  );

  // Keep timer titles in sync with DB titles as they become available
  context.subscriptions.push(
    titleResolver.onDidRefresh((titles) => {
      for (const timer of timerManager.getAll()) {
        const dbTitle = titles.get(timer.id);
        if (dbTitle && dbTitle !== timer.title) {
          timerManager.updateTitle(timer.id, dbTitle);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarProvider.viewType,
      sidebarProvider
    )
  );

  // Expiry warning at 30s remaining — only for open chats
  const warnedChats = new Set<string>();
  context.subscriptions.push(
    timerManager.onDidChange(() => {
      for (const timer of timerManager.getAll()) {
        if (
          openChatsTracker.isOpen(timer.id) &&
          !timer.isExpired &&
          timer.remainingSeconds <= 30 &&
          !warnedChats.has(timer.id)
        ) {
          warnedChats.add(timer.id);
          vscode.window.showWarningMessage(
            `Cache expiring in ${timer.remainingSeconds}s for "${timer.title}"`
          );
        }
      }
    })
  );

  // Expiry notification — only for open chats
  context.subscriptions.push(
    timerManager.onTimerExpired((timer) => {
      warnedChats.delete(timer.id);
      if (openChatsTracker.isOpen(timer.id)) {
        vscode.window.showErrorMessage(
          `Cache expired for "${timer.title}" — next message will incur a full cache write`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cacheTimer.resetAll", () => {
      timerManager.resetAll();
      warnedChats.clear();
      vscode.window.showInformationMessage("Cache timers cleared.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cacheTimer.showPanel", () => {
      vscode.commands.executeCommand("cacheTimer.sidebar.focus");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cacheTimer.openChat",
      (chatId: string) => {
        if (chatId) {
          SidebarProvider.openCursorChat(chatId);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cacheTimer.openSettings", async () => {
      const config = vscode.workspace.getConfiguration("cacheTimer");
      const currentTtl = config.get<number>("ttlSeconds", 300);

      const value = await vscode.window.showInputBox({
        title: "Cache Timer — TTL (seconds)",
        prompt: "Cache time-to-live in seconds",
        value: String(currentTtl),
        validateInput: (v) => {
          const n = Number(v);
          if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
            return "Enter a positive integer";
          }
          return undefined;
        },
      });

      if (value !== undefined) {
        await config.update(
          "ttlSeconds",
          Number(value),
          vscode.ConfigurationTarget.Global
        );
        vscode.window.showInformationMessage(
          `Cache TTL set to ${value} seconds.`
        );
      }
    })
  );

  await transcriptWatcher.start();
}

export function deactivate() {
  // Disposables are cleaned up via context.subscriptions
}
