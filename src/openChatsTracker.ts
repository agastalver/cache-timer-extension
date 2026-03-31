import * as vscode from "vscode";

const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

const COMMAND_PREFIXES = [
  "workbench.panel.composerChatViewPane.",
  "workbench.panel.aichat.view.",
];

export class OpenChatsTracker implements vscode.Disposable {
  private openIds: string[] = [];
  private openSet = new Set<string>();
  private pollInterval: ReturnType<typeof setInterval> | undefined;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor() {
    this.poll();
    this.pollInterval = setInterval(() => this.poll(), 5000);
  }

  isOpen(chatId: string): boolean {
    return this.openSet.has(chatId);
  }

  getOrderedOpenIds(): string[] {
    return this.openIds;
  }

  private async poll(): Promise<void> {
    try {
      const commands = await vscode.commands.getCommands(true);
      const ids = this.extractChatIds(commands);
      const ordered = this.orderByTabs(ids);

      const changed =
        ordered.length !== this.openIds.length ||
        ordered.some((id, i) => id !== this.openIds[i]);

      if (changed) {
        this.openIds = ordered;
        this.openSet = new Set(ordered);
        this._onDidChange.fire();
      }
    } catch {
      // getCommands may fail during shutdown
    }
  }

  private extractChatIds(commands: string[]): Set<string> {
    const ids = new Set<string>();
    for (const cmd of commands) {
      for (const prefix of COMMAND_PREFIXES) {
        if (cmd.startsWith(prefix)) {
          const match = cmd.match(UUID_PATTERN);
          if (match) {
            ids.add(match[0]);
          }
        }
      }
    }
    return ids;
  }

  /**
   * Try to order IDs using vscode.window.tabGroups (chat tabs may appear
   * as webview tabs). Falls back to the iteration order of the input set.
   */
  private orderByTabs(ids: Set<string>): string[] {
    if (ids.size === 0) {
      return [];
    }

    try {
      const tabOrder: string[] = [];
      const remaining = new Set(ids);

      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const label = tab.label ?? "";
          for (const id of remaining) {
            if (label.includes(id)) {
              tabOrder.push(id);
              remaining.delete(id);
              break;
            }
          }
        }
      }

      if (tabOrder.length > 0) {
        for (const id of remaining) {
          tabOrder.push(id);
        }
        return tabOrder;
      }
    } catch {
      // tabGroups API may not be available
    }

    return Array.from(ids);
  }

  dispose(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
    this._onDidChange.dispose();
  }
}
