/**
 * treeViewWebview.ts - WebView-based tree view provider
 * 
 * This module provides a WebView-based tree in the Explorer sidebar that displays
 * the transclusion hierarchy.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getForest, ForesterTree } from './get-forest';
import { getTaxonAbbreviation, getCustomTaxonConfig } from './utils';
import { renameTreeById } from './edit-forest';

interface TreeNode extends ForesterTree {
   title: string;
   transcludes: Set<string>;
   transcludedBy: Set<string>;
}

interface TreeViewState {
   expandedNodes: string[];
   pinnedRootIds: string[];
   focusMode: boolean;
   selectedNodeId?: string;
}

export class ForesterWebviewProvider implements vscode.WebviewViewProvider {
   public static readonly viewType = 'foresterTreeView';
   private static readonly STATE_KEY = 'foresterTreeView.state';
   private static readonly MAX_PINNED_ROOTS = 10; // Limit pinned roots to prevent unbounded growth

   private _view?: vscode.WebviewView;
   private nodes: Map<string, TreeNode> = new Map();
   private expandedNodes: Set<string> = new Set();
   private currentRootIds: string[] = [];
   private pinnedRootIds: string[] = [];
   private focusMode: boolean = false;
   private initialLoad: boolean = true;
   private selectedNodeId?: string;
   private disposables: vscode.Disposable[] = [];

   constructor(
      private readonly _extensionUri: vscode.Uri,
      private readonly _context: vscode.ExtensionContext
   ) {
      // Load saved state on construction
      this.loadState();
   }

   public resolveWebviewView(
      webviewView: vscode.WebviewView,
      context: vscode.WebviewViewResolveContext,
      _token: vscode.CancellationToken,
   ) {
      this._view = webviewView;

      webviewView.webview.options = {
         enableScripts: true,
         localResourceRoots: [this._extensionUri]
      };

      webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

      // Handle messages from the webview (store disposable)
      const messageDisposable = webviewView.webview.onDidReceiveMessage(data => {
         switch (data.type) {
            case 'toggle': {
               if (this.expandedNodes.has(data.nodeId)) {
                  this.expandedNodes.delete(data.nodeId);
               } else {
                  this.expandedNodes.add(data.nodeId);
               }
               // Auto-pin on interaction if not already pinned
               this.autoPinOnInteraction(data.nodeId);
               this.saveState(); // Save state after toggling
               if (this._view) {
                  this._view.webview.postMessage({
                     type: 'update',
                     html: this._getTreeHtml()
                  });
               }
               break;
            }
            case 'openFile': {
               const node = this.nodes.get(data.nodeId);
               if (node?.sourcePath) {
                  vscode.commands.executeCommand('vscode.open', vscode.Uri.file(node.sourcePath));
               }
               // Expand the node if it has children
               if (node && node.transcludes.size > 0) {
                  this.expandedNodes.add(data.nodeId);
               }
               // Mark as selected
               this.selectedNodeId = data.nodeId;
               // Auto-pin on interaction if not already pinned
               this.autoPinOnInteraction(data.nodeId);
               this.saveState(); // Save state after auto-pinning, selection, and expansion
               if (this._view) {
                  this._view.webview.postMessage({
                     type: 'update',
                     html: this._getTreeHtml()
                  });
               }
               break;
            }
            case 'togglePin': {
               const nodeId = data.nodeId;
               if (this.pinnedRootIds.includes(nodeId)) {
                  // Unpin
                  this.pinnedRootIds = this.pinnedRootIds.filter(id => id !== nodeId);
                  vscode.commands.executeCommand('setContext', 'foresterTreeViewPinned', this.pinnedRootIds.length > 0);
               } else {
                  // Pin (with limit check)
                  if (this.pinnedRootIds.length >= ForesterWebviewProvider.MAX_PINNED_ROOTS) {
                     vscode.window.showWarningMessage(`Cannot pin more than ${ForesterWebviewProvider.MAX_PINNED_ROOTS} roots`);
                  } else {
                     this.pinnedRootIds.push(nodeId);
                     this.expandedNodes.add(nodeId); // Expand when pinning
                     vscode.commands.executeCommand('setContext', 'foresterTreeViewPinned', true);
                  }
               }
               this.saveState(); // Save state after pin/unpin
               this.refresh();
               break;
            }
            case 'renameTree': {
               const node = this.nodes.get(data.nodeId);
               if (node) {
                  renameTreeById(node.uri).then(() => {
                     // Refresh after rename to show updated title
                     this.refresh();
                  });
               }
               break;
            }
         }
      });
      this.disposables.push(messageDisposable);

      // Listen for active editor changes (store disposable)
      const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
         // Refresh first to ensure nodes are populated
         await this.refresh();
         // Then update selection
         this.updateSelectionFromEditor(editor);
         // Refresh again to show the selection
         if (this._view) {
            this._view.webview.postMessage({
               type: 'update',
               html: this._getTreeHtml()
            });
         }
      });
      this.disposables.push(editorChangeDisposable);

      // Clean up disposables when webview is disposed
      webviewView.onDidDispose(() => {
         this.dispose();
      });

      // Initial load and set selection from current editor
      this.refresh().then(() => {
         const currentEditor = vscode.window.activeTextEditor;
         this.updateSelectionFromEditor(currentEditor);
         // Update view with selection
         if (this._view) {
            this._view.webview.postMessage({
               type: 'update',
               html: this._getTreeHtml()
            });
         }
      });
   }

   public async refresh() {
      await this.buildGraph();
      if (this._view) {
         this._view.webview.postMessage({
            type: 'update',
            html: this._getTreeHtml()
         });
      }
   }

   private autoPinOnInteraction(nodeId: string) {
      // Find the root of the interacted node
      const root = this.findRootForNode(nodeId);
      if (root && !this.pinnedRootIds.includes(root)) {
         this.pinnedRootIds.push(root);
         this.expandedNodes.add(root);
         vscode.commands.executeCommand('setContext', 'foresterTreeViewPinned', true);
      }
   }

   private findRootForNode(nodeId: string): string | null {
      // Check if this node is already a root
      if (this.currentRootIds.includes(nodeId)) {
         return nodeId;
      }

      // Otherwise, find which root contains this node
      for (const rootId of this.currentRootIds) {
         if (this.nodeContainsChild(rootId, nodeId, new Set())) {
            return rootId;
         }
      }

      return null;
   }

   private nodeContainsChild(parentId: string, targetId: string, visited: Set<string>): boolean {
      if (parentId === targetId) return true;
      if (visited.has(parentId)) return false;
      visited.add(parentId);

      const parent = this.nodes.get(parentId);
      if (!parent) return false;

      for (const childId of Array.from(parent.transcludes)) {
         if (this.nodeContainsChild(childId, targetId, visited)) {
            return true;
         }
      }

      return false;
   }

   private async buildGraph() {
      const forestData = await getForest();

      this.nodes.clear();

      // Build resolution map
      for (const entry of forestData) {
         if (!entry.uri) throw new Error('Unexpected lack of uri');

         const taxonPrefix = getTaxonAbbreviation(entry.taxon);
         const separator = taxonPrefix ? ': ' : '';



         const title = !entry.title || /(https?:\/\/)/.test(entry.title) ? entry.uri : entry.title

         const node = {
            ...entry,
            title: taxonPrefix + separator + title,
            transcludes: new Set<string>(),
            transcludedBy: new Set<string>(),
         };

         this.nodes.set(node.uri, node);
      }

      // Second pass: parse transclusions
      for (const [uri, node] of Array.from(this.nodes.entries())) {
         try {
            const content = fs.readFileSync(node.sourcePath, 'utf-8');

            // Extract transclusions (skip commented lines)
            const lines = content.split('\n');
            for (const line of lines) {
               // Skip lines that start with % (comments)
               if (line.trimStart().startsWith('%')) {
                  continue;
               }

               // Find transclusions in this line
               const transcludeMatches = Array.from(line.matchAll(/\\transclude\{([^}]+)\}/g));
               for (const match of transcludeMatches) {
                  const targetId = match[1];
                  const targetNode = this.nodes.get(targetId);

                  if (targetNode) {
                     node.transcludes.add(targetId);
                     targetNode.transcludedBy.add(uri);
                  }
               }
            }
         } catch (e) {
            console.error(`Error parsing tree file ${node.sourcePath}:`, e);
         }
      }

      // Determine current roots
      const editor = vscode.window.activeTextEditor;
      const currentTreeId = editor?.document.fileName.endsWith('.tree')
         ? path.basename(editor.document.fileName, '.tree')
         : null;

      this.currentRootIds = [...this.pinnedRootIds];

      if (currentTreeId) {
         const node = this.nodes.get(currentTreeId);
         if (node && node.transcludedBy.size === 0 && !this.currentRootIds.includes(currentTreeId)) {
            this.currentRootIds.push(currentTreeId);
         } else {
            const rootNode = this.findRoot(currentTreeId)
            if (!this.currentRootIds.includes(rootNode)) {
               this.currentRootIds.push(rootNode)
            }
         }
      }

      // On initial load, expand all root nodes to show first level (if no saved state)
      if (this.initialLoad) {
         // Only set default expanded state if we don't have saved state
         const savedState = this._context.workspaceState.get<TreeViewState>(ForesterWebviewProvider.STATE_KEY);
         if (!savedState || savedState.expandedNodes.length === 0) {
            for (const rootId of this.currentRootIds) {
               this.expandedNodes.add(rootId);
            }
         }
         this.initialLoad = false;
      }
   }

   private _getTreeHtml(): string {
      if (this.currentRootIds.length === 0) {
         return '<div class="empty">Open a .tree file to see its structure</div>';
      }

      const renderNode = (nodeId: string, depth: number = 0, visited: Set<string> = new Set()): string => {
         const node = this.nodes.get(nodeId);
         if (!node) return '';

         const isExpanded = this.expandedNodes.has(nodeId);
         const hasChildren = node.transcludes.size > 0;
         const isCycle = visited.has(nodeId);

         if (isCycle) {
            return `
               <div class="tree-item cycle" style="padding-left: ${8 + depth * 20}px">
                  <span class="chevron-space"></span>
                  <span class="label">↻ ${node.title || nodeId} (cycle)</span>
               </div>
            `;
         }

         visited.add(nodeId);
         const emoji = this.getTaxonEmoji(node.taxon);
         const titleText = (node.title || nodeId).toLowerCase();
         const isPinned = this.pinnedRootIds.includes(nodeId);
         const showPinButton = depth === 0; // Only show pin/unpin on root nodes
         const isRoot = depth === 0;

         // Build detailed tooltip
         const tooltipLines = [];
         if (node.taxon) {
            tooltipLines.push(`Taxon: ${node.taxon}`);
         }
         tooltipLines.push(`Title: ${node.title || '(untitled)'}`);

         tooltipLines.push(`ID: ${nodeId}`);
         if (node.transcludes.size > 0) {
            tooltipLines.push(`Transcludes: ${node.transcludes.size} items`);
         }
         const tooltip = tooltipLines.join('\n');

         let html = `
            <div class="tree-item ${this.selectedNodeId === nodeId ? 'selected' : ''} ${depth === 0 ? 'root' : ''}" style="padding-left: ${8 + depth * 20}px" title="${tooltip}">
               ${hasChildren ?
               `<span class="chevron ${isExpanded ? 'expanded' : ''}" data-node-id="${nodeId}">
                     <span class="codicon codicon-chevron-right"></span>
                  </span>` :
               '<span class="chevron-space"></span>'
            }
               <span class="label" data-node-id="${nodeId}">
                  <span class="emoji">${emoji}</span>
                  <span class="title-text ${isRoot ? 'root-title' : ''}">${titleText}</span>
               </span>
               ${showPinButton ?
               `<span class="pin-button ${isPinned ? 'pinned' : ''}" data-node-id="${nodeId}" title="${isPinned ? 'Unpin from view' : 'Pin to view (keep visible)'}">
                     ${isPinned ?
                  `<svg class="icon-svg" viewBox="0 0 384 512"><path d="M298.028 214.267L285.793 96H328c13.255 0 24-10.745 24-24V24c0-13.255-10.745-24-24-24H56C42.745 0 32 10.745 32 24v48c0 13.255 10.745 24 24 24h42.207L85.972 214.267C37.465 236.82 0 277.261 0 328c0 13.255 10.745 24 24 24h136v104c0 13.255 10.745 24 24 24h16c13.255 0 24-10.745 24-24V352h136c13.255 0 24-10.745 24-24 0-50.739-37.465-91.18-85.972-113.733z"/></svg>` :
                  `<svg class="icon-svg" viewBox="0 0 384 512"><path d="M298.028 214.267L285.793 96H328c13.255 0 24-10.745 24-24V24c0-13.255-10.745-24-24-24H56C42.745 0 32 10.745 32 24v48c0 13.255 10.745 24 24 24h42.207L85.972 214.267C37.465 236.82 0 277.261 0 328c0 13.255 10.745 24 24 24h136v104c0 13.255 10.745 24 24 24h16c13.255 0 24-10.745 24-24V352h136c13.255 0 24-10.745 24-24 0-50.739-37.465-91.18-85.972-113.733z"/></svg>`
               }
                  </span>` : ''
            }
            </div>
         `;

         if (hasChildren && isExpanded) {
            for (const childId of Array.from(node.transcludes)) {
               html += renderNode(childId, depth + 1, new Set(visited));
            }
         }

         return html;
      };

      let html = '';
      for (const rootId of this.currentRootIds) {
         html += renderNode(rootId);
      }
      return html;
   }

   private getTaxonEmoji(taxon?: string | null): string {
      const customConfig = getCustomTaxonConfig();

      if (!taxon) {
         // Use $default emoji if configured, otherwise use tree emoji
         return customConfig['$default']?.emoji as string || '🌲';
      }

      const lowerTaxon = taxon.toLowerCase();

      // Check custom configuration first
      if (customConfig[lowerTaxon]?.emoji) {
         return customConfig[lowerTaxon].emoji as string;
      }

      // Built-in mappings with updates
      if (lowerTaxon.includes('author')) return '👤';
      if (lowerTaxon.includes('person')) return '👤';
      if (lowerTaxon === 'paper') return '🚩';
      if (lowerTaxon === 'section') return '⚡️';

      // Use $default emoji if configured, otherwise use tree emoji
      return customConfig['$default']?.emoji as string || '🌲';
   }

   private _getHtmlForWebview(webview: vscode.Webview) {
      return `<!DOCTYPE html>
         <html lang="en">
         <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Forester Structure</title>
            <style>
               @font-face {
                  font-family: 'codicon';
                  src: url('${webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.ttf'))}') format('truetype');
               }
               
               body {
                  margin: 0;
                  padding: 0;
                  font-family: var(--vscode-font-family);
                  font-size: var(--vscode-font-size);
                  color: var(--vscode-foreground);
                  background-color: var(--vscode-sideBar-background);
               }
               
               .tree-container {
                  padding: 4px 0;
               }
               
               .tree-item {
                  display: flex;
                  align-items: center;
                  height: 22px;
                  line-height: 22px;
                  cursor: pointer;
                  user-select: none;
                  white-space: nowrap;
               }
               
               .tree-item:hover {
                  background-color: var(--vscode-list-hoverBackground);
               }
               
               .tree-item.selected {
                  background-color: var(--vscode-list-activeSelectionBackground);
               }
               
               .chevron, .chevron-space {
                  width: 20px;
                  height: 22px;
                  display: inline-flex;
                  align-items: center;
                  justify-content: center;
                  flex-shrink: 0;
               }
               
               .codicon {
                  font-family: 'codicon';
                  font-size: 16px;
                  display: inline-block;
                  text-decoration: none;
                  text-rendering: auto;
                  text-align: center;
                  -webkit-font-smoothing: antialiased;
                  -moz-osx-font-smoothing: grayscale;
                  user-select: none;
                  -webkit-user-select: none;
                  -ms-user-select: none;
               }
               
               .codicon-chevron-right::before {
                  content: '\\eab6';
               }
               
               .codicon-pin::before {
                  content: '\\eb90'; /* Using outline star icon */
               }

               .codicon-pinned::before {
                  content: '\\eb8f'; /* Using filled star icon */
               }
               
               .chevron .codicon {
                  transition: transform 0.1s;
               }
               
               .chevron.expanded .codicon {
                  transform: rotate(90deg);
               }
               
               .chevron:hover {
                  background-color: var(--vscode-toolbar-hoverBackground);
               }
               
               .label {
                  flex: 1;
                  padding: 0 4px;
                  overflow: hidden;
                  text-overflow: ellipsis;
               }
               
               
               /* Root node text styling */
               .root-title, .root-id {
                  text-decoration: underline;
               }
               
               /* Don't underline emojis */
               .emoji {
                  text-decoration: none !important;
                  display: inline-block;
               }
               
               .pin-button {
                  display: inline-flex;
                  align-items: center;
                  justify-content: center;
                  width: 22px;
                  height: 22px;
                  margin-left: auto;
                  margin-right: 4px;
                  cursor: pointer;
                  opacity: 0.4;
                  transition: all 0.2s;
                  border-radius: 3px;
                  color: var(--vscode-foreground);
               }

               .pin-button:hover {
                  opacity: 1;
                  background-color: var(--vscode-toolbar-hoverBackground);
               }

               .pin-button:hover .icon-svg {
                  transform: scale(1.2);
               }

               .pin-button.pinned {
                  opacity: 1;
                  color: var(--vscode-editorWarning-foreground, #FFB900);
               }

               .pin-button.pinned:hover {
                  opacity: 0.8;
               }

               .pin-button.pinned:hover .icon-svg {
                  transform: scale(1.2);
               }

               .icon-svg {
                  width: 14px;
                  height: 14px;
                  fill: currentColor;
                  display: block;
               }

               .cycle .label {
                  color: var(--vscode-descriptionForeground);
                  font-style: italic;
               }
               
               .empty {
                  padding: 10px;
                  color: var(--vscode-descriptionForeground);
                  font-style: italic;
               }
            </style>
         </head>
         <body>
            <div id="tree-container" class="tree-container"></div>
            <script>
               const vscode = acquireVsCodeApi();
               
               // Update tree HTML when we receive updates
               window.addEventListener('message', event => {
                  const message = event.data;
                  if (message.type === 'update') {
                     document.getElementById('tree-container').innerHTML = message.html;
                     attachEventListeners();
                  }
               });
               
               function attachEventListeners() {
                  // Click timers for distinguishing single/double clicks
                  const clickTimers = new Map();
                  const DOUBLE_CLICK_DELAY = 200; // ms

                  // Chevron clicks - only toggle expand/collapse
                  document.querySelectorAll('.chevron').forEach(chevron => {
                     chevron.onclick = (e) => {
                        e.stopPropagation();
                        const nodeId = chevron.getAttribute('data-node-id');
                        vscode.postMessage({ type: 'toggle', nodeId });
                     };
                  });

                  // Handle clicks on labels with single/double click detection
                  const handleClickableElement = (element, isLabel) => {
                     element.onclick = (e) => {
                        e.stopPropagation();
                        const nodeId = element.getAttribute('data-node-id');

                        // Check if there's a pending click
                        if (clickTimers.has(nodeId)) {
                           // Double click detected
                           clearTimeout(clickTimers.get(nodeId));
                           clickTimers.delete(nodeId);
                           vscode.postMessage({ type: 'renameTree', nodeId });
                        } else {
                           // First click - wait to see if it's a double click
                           const timer = setTimeout(() => {
                              clickTimers.delete(nodeId);
                              vscode.postMessage({ type: 'openFile', nodeId });
                           }, DOUBLE_CLICK_DELAY);
                           clickTimers.set(nodeId, timer);
                        }
                     };
                  };

                  // Label clicks - single opens file, double renames
                  document.querySelectorAll('.label').forEach(label => {
                     handleClickableElement(label, true);
                  });

                  // Pin button clicks
                  document.querySelectorAll('.pin-button').forEach(button => {
                     button.onclick = (e) => {
                        e.stopPropagation();
                        const nodeId = button.getAttribute('data-node-id');
                        vscode.postMessage({ type: 'togglePin', nodeId });
                     };
                  });
               }
            </script>
         </body>
         </html>`;
   }

   public pinToCurrentFile() {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.fileName.endsWith('.tree')) {
         const treeId = path.basename(editor.document.fileName, '.tree');
         const node = this.nodes.get(treeId);

         if (!node) {
            vscode.window.showWarningMessage('Tree not found in forest');
            return;
         }

         const rootId = node.transcludedBy.size > 0 ? this.findRoot(treeId) : treeId;

         if (rootId && !this.pinnedRootIds.includes(rootId)) {
            this.pinnedRootIds.push(rootId);
            // Expand the newly pinned root to show first level
            this.expandedNodes.add(rootId);
            this.saveState(); // Save state after pinning
            this.refresh();
            vscode.window.showInformationMessage(`Pinned: ${this.nodes.get(rootId)?.title || rootId}`);
         }
      }
   }

   public unpin() {
      if (this.pinnedRootIds.length > 0) {
         const unpinned = this.pinnedRootIds.pop();
         this.saveState(); // Save state after unpinning
         this.refresh();
         vscode.window.showInformationMessage(`Unpinned: ${unpinned}`);
      }
   }

   public toggleFocusMode() {
      this.focusMode = !this.focusMode;
      this.saveState(); // Save state after toggling focus mode
      this.refresh();
      vscode.window.showInformationMessage(`Focus mode ${this.focusMode ? 'enabled' : 'disabled'}`);
   }

   public expandAll() {
      // Add all nodes to expanded set
      for (const [nodeId, node] of Array.from(this.nodes)) {
         if (node.transcludes.size > 0) {
            this.expandedNodes.add(nodeId);
         }
      }
      this.saveState(); // Save state after expanding all
      this.refresh();
   }

   public collapseAll() {
      // Clear all expanded nodes (including roots)
      this.expandedNodes.clear();

      // Re-expand root nodes only
      for (const rootId of this.currentRootIds) {
         this.expandedNodes.add(rootId);
      }

      this.saveState(); // Save state after collapsing
      this.refresh();
   }

   private findRoot(treeId: string): string {
      const node = this.nodes.get(treeId);
      if (!node || node.transcludedBy.size === 0) return treeId;

      const visited = new Set<string>();
      let current = treeId;

      while (true) {
         if (visited.has(current)) return treeId; // Cycle
         visited.add(current);

         const currentNode = this.nodes.get(current);
         if (!currentNode || currentNode.transcludedBy.size === 0) {
            return current;
         }

         current = Array.from(currentNode.transcludedBy)[0];
      }
   }

   private loadState(): void {
      const savedState = this._context.workspaceState.get<TreeViewState>(ForesterWebviewProvider.STATE_KEY);
      if (savedState) {
         this.expandedNodes = new Set(savedState.expandedNodes);
         this.pinnedRootIds = savedState.pinnedRootIds;
         this.focusMode = savedState.focusMode;
         this.selectedNodeId = savedState.selectedNodeId;

         // Update context for pinned state
         vscode.commands.executeCommand('setContext', 'foresterTreeViewPinned', this.pinnedRootIds.length > 0);
      }
   }

   private saveState(): void {
      const state: TreeViewState = {
         expandedNodes: Array.from(this.expandedNodes),
         pinnedRootIds: this.pinnedRootIds,
         focusMode: this.focusMode,
         selectedNodeId: this.selectedNodeId
      };

      this._context.workspaceState.update(ForesterWebviewProvider.STATE_KEY, state);
   }

   public dispose(): void {
      // Clean up all disposables
      this.disposables.forEach(d => d.dispose());
      this.disposables = [];

      // Clear data structures
      this.nodes.clear();
      this.expandedNodes.clear();
      this.currentRootIds = [];
      this.pinnedRootIds = [];
   }

   private updateSelectionFromEditor(editor: vscode.TextEditor | undefined): void {
      if (!editor || !editor.document.fileName.endsWith('.tree')) {
         return;
      }

      const treeId = path.basename(editor.document.fileName, '.tree');
      const node = this.nodes.get(treeId);

      console.log(`Updating selection for tree: ${treeId}, node found: ${!!node}`);

      if (node) {
         // Update selected node
         this.selectedNodeId = treeId;

         // Reveal the node if it's collapsed by expanding parent nodes
         this.revealNode(treeId);

         // Save state
         this.saveState();

         console.log(`Selection updated to: ${treeId}`);
      }
   }

   private revealNode(nodeId: string): void {

      // Find the path from root to this node
      const findPath = (targetId: string): string[] => {
         // Check if it's a root node
         if (this.currentRootIds.includes(targetId)) {
            return [targetId];
         }

         // Find parent that contains this node
         for (const [parentId, parentNode] of this.nodes.entries()) {
            if (parentNode.transcludes.has(targetId)) {
               const parentPath = findPath(parentId);
               if (parentPath.length > 0) {
                  return [...parentPath, targetId];
               }
            }
         }

         return [];
      };

      const path = findPath(nodeId);

      // Expand all nodes in the path except the target node itself
      for (let i = 0; i < path.length - 1; i++) {
         this.expandedNodes.add(path[i]);
      }
   }
}