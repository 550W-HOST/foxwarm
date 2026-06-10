/**
 * TUI (Terminal User Interface) Channel
 * Provides a blessed-based terminal interface with logs and chat tabs
 */

import blessed from 'blessed';
import { Channel, ChannelContext, ChannelMessage } from '../channel';
import { logger } from '../common';
import * as sessionManager from '../sessionManager';

export class TUIChannel implements Channel {
  readonly name = 'tui';
  readonly platform = 'tui';
  
  private screen: blessed.Widgets.Screen;
  private logsBox: blessed.Widgets.Log;
  private chatBox: blessed.Widgets.BoxElement;
  private sessionList: blessed.Widgets.ListElement;
  private chatLog: blessed.Widgets.Log;
  private inputBox: blessed.Widgets.TextboxElement;
  private statusBar: blessed.Widgets.TextElement;
  
  private currentTab: 'logs' | 'chat' = 'logs';
  private currentSessionId: string | null = null;
  private inChatMode = false;
  private isProcessing = false;
  private statusUpdateInterval: NodeJS.Timeout | null = null;
  
  private messageHandler?: (ctx: ChannelContext, message: ChannelMessage) => Promise<void>;
  private commandHandler?: (ctx: ChannelContext, command: string, args: string[]) => Promise<boolean>;

  constructor() {    
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Foxwarm TUI',
      terminal: 'xterm-256color',
      unicode: true,
      autoPadding: true,
      resizeTimeout: 500,
      dockBorders: false,
      fullUnicode: true
    });

    // Create logs box
    this.logsBox = blessed.log({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%-1',
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: ' ',
        style: {
          bg: 'blue'
        }
      },
      border: {
        type: 'line'
      },
      style: {
        border: {
          fg: 'cyan'
        }
      },
      label: ' Logs (Tab to switch) '
    });

    // Create chat container
    this.chatBox = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%-1',
      hidden: true
    });

    // Session list (left side)
    this.sessionList = blessed.list({
      parent: this.chatBox,
      top: 0,
      left: 0,
      width: '30%',
      height: '100%',
      keys: true,
      vi: true,
      mouse: true,
      border: {
        type: 'line'
      },
      style: {
        border: {
          fg: 'cyan'
        },
        selected: {
          bg: 'blue',
          fg: 'white'
        }
      },
      label: ' Sessions '
    });

    // Chat log (right side, top)
    this.chatLog = blessed.log({
      parent: this.chatBox,
      top: 0,
      left: '30%',
      width: '70%',
      height: '100%-5',
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: ' ',
        style: {
          bg: 'blue'
        }
      },
      border: {
        type: 'line'
      },
      style: {
        border: {
          fg: 'cyan'
        }
      },
      label: ' Chat '
    });

    // Input box (right side, bottom)
    this.inputBox = blessed.textbox({
      parent: this.chatBox,
      bottom: 0,
      left: '30%',
      width: '70%',
      height: 5,
      inputOnFocus: true,
      keys: true,
      mouse: true,
      border: {
        type: 'line'
      },
      style: {
        border: {
          fg: 'green'
        },
        focus: {
          border: {
            fg: 'yellow'
          }
        }
      },
      label: ' Input (Enter to send, Esc to cancel) '
    });

    // Status bar
    this.statusBar = blessed.text({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      content: ' Tab: Switch | q: Quit | ↑↓: Navigate | Enter: Select/Send | F12: Redraw',
      style: {
        bg: 'blue',
        fg: 'white'
      }
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    // Global key handlers
    this.screen.key(['q', 'C-c'], () => {
      this.showExitConfirmation();
    });

    this.screen.key(['tab'], () => {
      this.switchTab();
    });

    this.screen.key(['f12', 'F12'], () => {
      this.fullRedraw();
    });

    // Session list handlers
    this.sessionList.key(['enter'], () => {
      const list = this.sessionList as any;
      const items = list.ritems || [];
      const selected = list.selected || 0;
      if (selected >= 0 && selected < items.length) {
        // Remove prefix and extract session ID
        const itemText = items[selected];
        const sessionId = itemText.replace(/^[* ]\s*/, '').split(' ')[0];
        this.enterChat(sessionId);
      }
    });

    this.sessionList.key(['escape'], () => {
      if (this.inChatMode) {
        this.exitChat();
      }
    });

    // Add selection change handler for preview
    this.sessionList.on('select', () => {
      this.updateSessionPreview();
    });

    // Input box handlers - Back to simple Enter to submit
    this.inputBox.on('submit', async (value: string) => {
      // Ensure proper UTF-8 handling
      const cleanValue = Buffer.from(value, 'utf8').toString('utf8').trim();
      if (cleanValue && this.currentSessionId && this.messageHandler) {
        await this.sendChatMessage(cleanValue);
      }
      this.inputBox.clearValue();
      this.screen.render();
      // Focus after clear and render to avoid duplicate input
      this.inputBox.focus();
    });

    this.inputBox.key(['escape'], () => {
      this.inputBox.clearValue();
      this.sessionList.focus();
      this.screen.render();
    });
  }

  private switchTab() {
    if (this.currentTab === 'logs') {
      this.currentTab = 'chat';
      this.logsBox.hide();
      this.chatBox.show();
      
      // Show session list for selection
      this.sessionList.focus();
      this.refreshSessionList();
      
      // Trigger preview for selected session
      setTimeout(() => {
        this.updateSessionPreview();
      }, 100);
    } else {
      this.currentTab = 'logs';
      this.chatBox.hide();
      this.logsBox.show();
      this.logsBox.focus();
    }
    this.screen.render();
  }

  private refreshSessionList() {
    const sessions = Array.from(sessionManager.getAllSessions().values());
    const sessionIds = Array.from(sessionManager.getAllSessions().keys());
    const boundSessionId = sessionManager.getSessionByChannel('tui', 'tui');
    
    const items = sessions.map((s, idx) => {
      const msgCount = s.history.length;
      const lastTime = 'N/A';
      // Use session ID from the keys array
      const sessionId = sessionIds[idx];
      const isBound = sessionId === boundSessionId;
      
      const prefix = isBound ? '* ' : '  ';
      return `${prefix}${sessionId} (${msgCount} msgs, ${lastTime})`;
    });
    this.sessionList.setItems(items);
    
    // Auto-select bound session if available, otherwise main
    let selectSessionId = boundSessionId || 'main';
    const currentIndex = sessionIds.indexOf(selectSessionId);
    if (currentIndex >= 0) {
      this.sessionList.select(currentIndex);
    }
    
    // Update preview if in chat mode
    if (this.currentTab === 'chat' && !this.inChatMode) {
      setTimeout(() => {
        this.updateSessionPreview();
      }, 100);
    }
    
    this.screen.render();
  }

  private enterChat(sessionId: string) {
    this.currentSessionId = sessionId;
    this.inChatMode = true;
    this.chatLog.setLabel(` Chat: ${sessionId} (preview) `);
    this.loadChatHistory(sessionId);
    this.inputBox.focus();
    this.updateProcessingStatus();
    this.screen.render();
  }

  private exitChat() {
    this.currentSessionId = null;
    this.inChatMode = false;
    this.chatLog.setContent('');
    this.chatLog.setLabel(' Chat ');
    this.sessionList.focus();
    this.screen.render();
  }

  private async loadChatHistory(sessionId: string) {
    const session = await sessionManager.getSession(sessionId);
    this.chatLog.setContent('');
    
    // Show session info
    this.chatLog.log(`{cyan-fg}Loading session: ${sessionId}{/cyan-fg}`);
    this.chatLog.log(`{cyan-fg}Message count: ${session.history.length}{/cyan-fg}`);
    this.chatLog.log('');
    
    for (const msg of session.history) {
      // Skip tool messages for cleaner display
      if (msg.role === 'tool') continue;
      
      const role = msg.role === 'user' ? '{blue-fg}User{/blue-fg}' : '{green-fg}Assistant{/green-fg}';
      const content = msg.parts.map(p => p.text || '').join('');
      const cleanContent = Buffer.from(content, 'utf8').toString('utf8');
      // For now, don't show timestamp since it's not available in the message format
      this.chatLog.log(`${role}: ${cleanContent}`);
    }
    
    this.screen.render();
  }

  private async updateSessionPreview() {
    const list = this.sessionList as any;
    const items = list.ritems || [];
    const selected = list.selected || 0;
    
    if (selected >= 0 && selected < items.length) {
      const itemText = items[selected];
      const sessionId = itemText.replace(/^[* ]\s*/, '').split(' ')[0];
      
      try {
        const session = await sessionManager.getSession(sessionId);
        const recentMessages = session.history.slice(-20); // Last 20 messages
        
        this.chatLog.setContent('');
        this.chatLog.log(`{cyan-fg}Preview: ${sessionId}{/cyan-fg}`);
        this.chatLog.log(`{cyan-fg}Total messages: ${session.history.length}{/cyan-fg}`);
        this.chatLog.log('{yellow-fg}(Showing last 20 messages){/yellow-fg}');
        this.chatLog.log('');
        
        for (const msg of recentMessages) {
          if (msg.role === 'tool') continue;
          
          const role = msg.role === 'user' ? '{blue-fg}User{/blue-fg}' : '{green-fg}Assistant{/green-fg}';
          const content = msg.parts.map(p => p.text || '').join('');
          const cleanContent = Buffer.from(content, 'utf8').toString('utf8');
          // Truncate long messages for preview
          const truncated = cleanContent.length > 200 ? cleanContent.substring(0, 200) + '...' : cleanContent;
          this.chatLog.log(`${role}: ${truncated}`);
        }
        
        this.screen.render();
      } catch (e) {
        this.chatLog.setContent('');
        this.chatLog.log(`{red-fg}Error loading preview for ${sessionId}{/red-fg}`);
        this.screen.render();
      }
    }
  }

  private async sendChatMessage(text: string) {
    if (!this.currentSessionId || !this.messageHandler) return;

    // Bind to session only when sending first message
    const boundSessionId = sessionManager.getSessionByChannel('tui', 'tui');
    if (!boundSessionId || boundSessionId !== this.currentSessionId) {
      sessionManager.attachChannel('tui', 'tui', this.currentSessionId);
      this.chatLog.setLabel(` Chat: ${this.currentSessionId} (active) `);
      this.displayMessage('assistant', `{cyan-fg}Bound to session: ${this.currentSessionId}{/cyan-fg}`);
    }

    const ctx: ChannelContext = {
      channelId: 'tui',
      channelType: 'tui',
      channelUserId: 'tui',
      conversationId: 'tui',
      username: 'tui-user',
      platform: 'tui',
      reply: async (replyText: string) => {
        // Check if this is a command response by checking if original text starts with /
        const isCommand = text.startsWith('/');
        
        if (isCommand) {
          // Display command response as system message (temporary, not saved to history)
          this.displayMessage('system', replyText);
        } else {
          this.displayMessage('assistant', replyText);
        }
      },
      sendTyping: async () => {
        // Show typing indicator in TUI
        this.displayMessage('assistant', '🤔 Thinking...');
      }
    };

    const message: ChannelMessage = {
      parts: [{ text }],
      channelUserId: 'tui',
      conversationId: 'tui',
      username: 'tui-user'
    };

    this.displayMessage('user', text);
    
    // Send message without waiting for response (like WebUI)
    this.messageHandler(ctx, message).catch(e => {
      this.displayMessage('assistant', 'Error: Failed to send message');
    });
  }

  private showExitConfirmation() {
    // Create confirmation dialog
    const dialog = blessed.box({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '50%',
      height: '20%',
      border: {
        type: 'line'
      },
      style: {
        border: {
          fg: 'yellow'
        },
        bg: 'blue',
        fg: 'white'
      },
      label: ' Confirm Exit ',
      content: ' Are you sure you want to exit?\n\n Press Y to confirm, N to cancel '
    });

    // Key handlers for confirmation
    this.screen.key(['y', 'Y'], () => {
      dialog.destroy();
      this.screen.render();
      return process.exit(0);
    });

    this.screen.key(['n', 'N', 'escape'], () => {
      dialog.destroy();
      this.screen.render();
      // Remove the temporary key handlers
      this.screen.removeKey('y', () => {});
      this.screen.removeKey('Y', () => {});
      this.screen.removeKey('n', () => {});
      this.screen.removeKey('N', () => {});
      this.screen.removeKey('escape', () => {});
    });

    this.screen.render();
  }

  private fullRedraw() {
    // Force complete screen redraw without destroying
    this.screen.program.reset();
    this.screen.render();
    
    // Show redraw notification
    if (this.currentTab === 'logs') {
      this.logsBox.log('{yellow-fg}Screen redrawn{/yellow-fg}');
    }
    
    // Update status bar to show redraw hint
    const status = this.isProcessing ? '🔄 Processing' : '✅ Ready';
    this.statusBar.setContent(` Tab: Switch | q: Quit | ↑↓: Navigate | Enter: Select/Send | F12: Redraw | Status: ${status}`);
    
    this.screen.render();
  }

  private updateProcessingStatus() {
    if (!this.currentSessionId) return;
    
    const sessions = sessionManager.getAllSessions();
    const session = sessions.get(this.currentSessionId);
    const wasProcessing = this.isProcessing;
    this.isProcessing = session?.busy || false;
    
    // Update status bar to show processing state
    const status = this.isProcessing ? '🔄 Processing' : '✅ Ready';
    this.statusBar.setContent(` Tab: Switch | q: Quit | ↑↓: Navigate | Enter: Select/Send | F12: Redraw | Status: ${status}`);
    
    // Update chat label to show status
    if (this.inChatMode) {
      const statusIcon = this.isProcessing ? '🔄' : '✅';
      this.chatLog.setLabel(` Chat: ${this.currentSessionId} ${statusIcon} `);
    }
    
    // Render if status changed
    if (wasProcessing !== this.isProcessing) {
      this.screen.render();
    }
  }

  private displayMessage(role: 'user' | 'assistant' | 'system', text: string) {
    const roleLabel = role === 'user' ? '{blue-fg}User{/blue-fg}' : 
                     role === 'assistant' ? '{green-fg}Assistant{/green-fg}' : 
                     '{yellow-fg}System{/yellow-fg}';
    const time = new Date().toLocaleTimeString('en-US');
    // Ensure proper UTF-8 encoding for display
    const cleanText = Buffer.from(text, 'utf8').toString('utf8');
    this.chatLog.log(`[${time}] ${roleLabel}: ${cleanText}`);
    this.screen.render();
  }

  // Intercept logger output and display in logs box
  public logToTUI(level: string, message: string) {
    const color = level === 'ERROR' ? 'red' : level === 'WARN' ? 'yellow' : 'white';
    const time = new Date().toLocaleTimeString('en-US');
    // Ensure proper UTF-8 encoding for display
    const cleanMessage = Buffer.from(message, 'utf8').toString('utf8');
    this.logsBox.log(`{${color}-fg}[${time}] [${level}]{/${color}-fg} ${cleanMessage}`);
    this.screen.render();
  }

  async start(): Promise<void> {
    this.logsBox.log('{green-fg}TUI Channel started{/green-fg}');
    this.logsBox.log('Press {yellow-fg}Tab{/yellow-fg} to switch between Logs and Chat');
    this.logsBox.log('Press {yellow-fg}q{/yellow-fg} to quit');
    this.logsBox.log('In Chat mode: {yellow-fg}Select a session{/yellow-fg} to start chatting');
    
    // Start status update interval
    this.statusUpdateInterval = setInterval(() => {
      this.updateProcessingStatus();
    }, 500); // Update every 500ms
    
    this.screen.render();
  }

  async stop(): Promise<void> {
    if (this.statusUpdateInterval) {
      clearInterval(this.statusUpdateInterval);
      this.statusUpdateInterval = null;
    }
    this.screen.destroy();
  }

  onMessage(handler: (ctx: ChannelContext, message: ChannelMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  onCommand(handler: (ctx: ChannelContext, command: string, args: string[]) => Promise<boolean>): void {
    this.commandHandler = handler;
  }

  async sendMessage(userId: string, messageText: string, options?: any): Promise<void> {
    // Messages are displayed via reply() callback
  }

  async sendTyping(userId: string): Promise<void> {
    // No-op for TUI
  }

  getScreen(): blessed.Widgets.Screen {
    return this.screen;
  }
}
