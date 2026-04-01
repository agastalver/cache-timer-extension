import * as vscode from "vscode";
import { TimerManager } from "./timerManager";
import { TranscriptWatcher } from "./transcriptWatcher";
import { ChatTitleResolver } from "./chatTitleResolver";
import { StatusBar } from "./statusBar";
import { SidebarProvider } from "./sidebarProvider";
import { OpenChatsTracker } from "./openChatsTracker";
import { CacheKeepManager } from "./cacheKeepManager";
import { AiTrackingDbWatcher } from "./aiTrackingDbWatcher";

export async function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel("Cache Timer");
  log.appendLine(`[Activate] Cache Timer v${context.extension.packageJSON.version}`);

  const timerManager = new TimerManager();
  const titleResolver = new ChatTitleResolver(log);
  const transcriptWatcher = new TranscriptWatcher(titleResolver, log);
  const openChatsTracker = new OpenChatsTracker();
  const aiTrackingWatcher = new AiTrackingDbWatcher(log);
  const cacheKeepManager = new CacheKeepManager(timerManager);
  const statusBar = new StatusBar(timerManager, openChatsTracker);
  const sidebarProvider = new SidebarProvider(
    context.extensionUri,
    timerManager,
    openChatsTracker,
    cacheKeepManager,
    transcriptWatcher
  );

  context.subscriptions.push(
    log,
    timerManager,
    titleResolver,
    transcriptWatcher,
    openChatsTracker,
    aiTrackingWatcher,
    cacheKeepManager,
    statusBar,
    sidebarProvider
  );

  context.subscriptions.push(
    transcriptWatcher.onAssistantMessage((event) => {
      timerManager.resetTimer(event.chatId, event.title, event.timestamp);
    })
  );

  context.subscriptions.push(
    transcriptWatcher.onChatActivity((event) => {
      timerManager.touchTimer(event.chatId, event.timestamp);
    })
  );

  context.subscriptions.push(
    transcriptWatcher.onStreamingChange(({ chatId, streaming }) => {
      timerManager.setStreaming(chatId, streaming, "transcript");
    })
  );

  context.subscriptions.push(
    aiTrackingWatcher.onStreamingChange(({ chatId, streaming }) => {
      timerManager.setStreaming(chatId, streaming, "aiTracking");
    })
  );

  context.subscriptions.push(
    aiTrackingWatcher.onChatActivity(({ chatId, timestamp }) => {
      timerManager.touchTimer(chatId, timestamp);
    })
  );

  // Auto-reset cache keep timer when the user manually sends a message
  context.subscriptions.push(
    transcriptWatcher.onUserMessage(({ chatId, messageText }) => {
      if (
        cacheKeepManager.isKeeping(chatId) &&
        messageText !== CacheKeepManager.KEEP_MESSAGE
      ) {
        cacheKeepManager.resetKeep(chatId);
      }
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
    vscode.commands.registerCommand("cacheTimer.refresh", async () => {
      transcriptWatcher.forceRescan();
      await openChatsTracker.forcePoll();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cacheTimer.openSettings", () => {
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "cacheTimer"
      );
    })
  );

  const settingEditors: Array<{
    command: string;
    key: string;
    title: string;
    defaultVal: number;
    min: number;
  }> = [
    { command: "cacheTimer.editTtl", key: "ttlSeconds", title: "Cache TTL (seconds)", defaultVal: 280, min: 1 },
    { command: "cacheTimer.editKeepDuration", key: "cacheKeepDurationSeconds", title: "Cache Keep Duration (seconds)", defaultVal: 1800, min: 60 },
  ];

  for (const s of settingEditors) {
    context.subscriptions.push(
      vscode.commands.registerCommand(s.command, async () => {
        const config = vscode.workspace.getConfiguration("cacheTimer");
        const current = config.get<number>(s.key, s.defaultVal);
        const value = await vscode.window.showInputBox({
          title: `Cache Timer — ${s.title}`,
          prompt: s.title,
          value: String(current),
          validateInput: (v) => {
            const n = Number(v);
            if (!Number.isFinite(n) || n < s.min || !Number.isInteger(n)) {
              return `Enter an integer >= ${s.min}`;
            }
            return undefined;
          },
        });
        if (value !== undefined) {
          await config.update(s.key, Number(value), vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage(`${s.title} set to ${value}.`);
        }
      })
    );
  }

  await transcriptWatcher.start();
  await aiTrackingWatcher.start();
}

export function deactivate() {
  // Disposables are cleaned up via context.subscriptions
}
