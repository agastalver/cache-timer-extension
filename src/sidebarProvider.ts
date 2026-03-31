import * as vscode from "vscode";
import { TimerManager } from "./timerManager";
import { OpenChatsTracker } from "./openChatsTracker";

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "cacheTimer.sidebar";

  private view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly timerManager: TimerManager,
    private readonly openChatsTracker: OpenChatsTracker
  ) {
    this.disposables.push(
      timerManager.onDidChange(() => this.sendUpdate())
    );
    this.disposables.push(
      openChatsTracker.onDidChange(() => this.sendUpdate())
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
      }
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });

    this.sendUpdate();
  }

  static async openCursorChat(chatId: string): Promise<void> {
    const candidates = [
      `workbench.panel.aichat.view.${chatId}.focus`,
      `workbench.panel.composerChatViewPane.${chatId}.focus`,
    ];
    for (const cmd of candidates) {
      try {
        await vscode.commands.executeCommand(cmd);
        return;
      } catch {
        // Command not found, try next
      }
    }
    try {
      await vscode.commands.executeCommand(
        "composerChatViewPane.focus",
        chatId
      );
    } catch {
      // Not supported
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
      timers: timers.map((t) => ({
        id: t.id,
        title: t.title,
        remainingSeconds: t.remainingSeconds,
        isExpired: t.isExpired,
        lastAssistantTime: t.lastAssistantTime,
      })),
    });
  }

  private getHtml(): string {
    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 8px;
    }

    .empty {
      text-align: center;
      padding: 24px 8px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }

    .section { margin-bottom: 12px; }

    .section-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 2px;
      cursor: pointer;
      user-select: none;
      color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
      font-size: 0.8em;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.8;
    }

    .section-header:hover { opacity: 1; }

    .section-chevron {
      display: inline-block;
      transition: transform 0.15s;
      font-size: 0.75em;
    }
    .section-chevron.collapsed { transform: rotate(-90deg); }

    .section-count {
      font-weight: 400;
      opacity: 0.6;
      font-size: 0.9em;
    }

    .section-body { overflow: hidden; }
    .section-body.collapsed { display: none; }

    .chat-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .chat-card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 6px;
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 5px;
      cursor: pointer;
      transition: background 0.1s;
    }

    .chat-card:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .chat-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }

    .chat-title {
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
      min-width: 0;
      font-size: 0.95em;
    }

    .timer-badge {
      font-variant-numeric: tabular-nums;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 0.85em;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .timer-green {
      background: rgba(0, 180, 0, 0.15);
      color: #4ec94e;
    }
    .timer-yellow {
      background: rgba(220, 180, 0, 0.15);
      color: #dcb400;
    }
    .timer-red {
      background: rgba(220, 50, 50, 0.15);
      color: #e05050;
    }
    .timer-expired {
      background: rgba(128, 128, 128, 0.12);
      color: var(--vscode-descriptionForeground);
    }

    .progress-track {
      height: 3px;
      border-radius: 2px;
      background: var(--vscode-widget-border, rgba(128,128,128,0.2));
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      border-radius: 2px;
      transition: width 1s linear, background-color 0.3s;
    }

    .progress-green  { background: #4ec94e; }
    .progress-yellow { background: #dcb400; }
    .progress-red    { background: #e05050; }
    .progress-expired { background: transparent; }
  </style>
</head>
<body>
  <div id="root">
    <div class="empty">No active cache timers</div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const root = document.getElementById("root");
    let TTL = 300;
    let currentOpenChatIds = [];
    const collapsedState = {};

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type === "update") {
        if (msg.ttl) { TTL = msg.ttl; }
        currentOpenChatIds = msg.openChatIds || [];
        render(msg.timers);
      }
    });

    function render(timers) {
      if (!timers || timers.length === 0) {
        root.innerHTML = '<div class="empty">No active cache timers</div>';
        return;
      }

      const openSet = new Set(currentOpenChatIds);
      const openTimers = [];
      const otherTimers = [];

      // Separate open chats from the rest
      for (const t of timers) {
        if (openSet.has(t.id)) {
          openTimers.push(t);
        } else {
          otherTimers.push(t);
        }
      }

      // Sort open timers to match the tab order from openChatIds
      const orderMap = {};
      currentOpenChatIds.forEach((id, idx) => { orderMap[id] = idx; });
      openTimers.sort((a, b) => (orderMap[a.id] ?? 0) - (orderMap[b.id] ?? 0));

      let html = "";

      // Open Chats section (always first, always expanded by default)
      if (openTimers.length > 0) {
        const key = "Open Chats";
        if (!(key in collapsedState)) {
          collapsedState[key] = false;
        }
        const isCollapsed = collapsedState[key] === true;
        html += renderSection({ label: key, items: openTimers }, isCollapsed);
      }

      // Date-grouped sections for non-open chats
      const sections = groupByDate(otherTimers);
      for (const section of sections) {
        const isCollapsed = collapsedState[section.label] === true;
        html += renderSection(section, isCollapsed);
      }

      if (html === "") {
        root.innerHTML = '<div class="empty">No active cache timers</div>';
        return;
      }

      root.innerHTML = html;

      root.querySelectorAll(".section-header").forEach(header => {
        header.addEventListener("click", () => {
          const sectionKey = header.dataset.section;
          collapsedState[sectionKey] = !collapsedState[sectionKey];
          const body = header.nextElementSibling;
          const chevron = header.querySelector(".section-chevron");
          if (body) body.classList.toggle("collapsed");
          if (chevron) chevron.classList.toggle("collapsed");
        });
      });

      root.querySelectorAll(".chat-card").forEach(card => {
        card.addEventListener("click", () => {
          const chatId = card.dataset.chatId;
          if (chatId) {
            vscode.postMessage({ type: "openChat", chatId: chatId });
          }
        });
      });
    }

    function groupByDate(timers) {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const yesterdayStart = todayStart - 86400000;
      const weekStart = todayStart - 6 * 86400000;

      const groups = {
        "Today": [],
        "Yesterday": [],
        "Last Week": [],
        "Older": []
      };

      for (const t of timers) {
        const ts = t.lastAssistantTime;
        if (ts >= todayStart) {
          groups["Today"].push(t);
        } else if (ts >= yesterdayStart) {
          groups["Yesterday"].push(t);
        } else if (ts >= weekStart) {
          groups["Last Week"].push(t);
        } else {
          groups["Older"].push(t);
        }
      }

      const result = [];
      for (const [label, items] of Object.entries(groups)) {
        if (items.length > 0) {
          if (!(label in collapsedState)) {
            collapsedState[label] = (label === "Older");
          }
          result.push({ label, items });
        }
      }
      return result;
    }

    function renderSection(section, isCollapsed) {
      const chevronClass = isCollapsed ? "section-chevron collapsed" : "section-chevron";
      const bodyClass = isCollapsed ? "section-body collapsed" : "section-body";

      return '<div class="section">' +
        '<div class="section-header" data-section="' + escapeHtml(section.label) + '">' +
          '<span class="' + chevronClass + '">&#9660;</span>' +
          '<span>' + escapeHtml(section.label) + '</span>' +
          '<span class="section-count">(' + section.items.length + ')</span>' +
        '</div>' +
        '<div class="' + bodyClass + '">' +
          '<div class="chat-list">' +
            section.items.map(t => renderCard(t)).join("") +
          '</div>' +
        '</div>' +
      '</div>';
    }

    function renderCard(t) {
      const colorClass = getColorClass(t);
      const display = t.isExpired
        ? "expired"
        : formatTime(t.remainingSeconds);
      const pct = t.isExpired ? 0 : (t.remainingSeconds / TTL) * 100;

      return '<div class="chat-card" data-chat-id="' + escapeHtml(t.id) + '">' +
        '<div class="chat-header">' +
          '<span class="chat-title" title="' + escapeHtml(t.title) + '">' + escapeHtml(t.title) + '</span>' +
          '<span class="timer-badge timer-' + colorClass + '">' + display + '</span>' +
        '</div>' +
        '<div class="progress-track">' +
          '<div class="progress-fill progress-' + colorClass + '" style="width:' + pct + '%"></div>' +
        '</div>' +
      '</div>';
    }

    function getColorClass(t) {
      if (t.isExpired) return "expired";
      if (t.remainingSeconds <= 60) return "red";
      if (t.remainingSeconds <= 180) return "yellow";
      return "green";
    }

    function formatTime(sec) {
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return m + ":" + String(s).padStart(2, "0");
    }

    function escapeHtml(str) {
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
  </script>
</body>
</html>`;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
