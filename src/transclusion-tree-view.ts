/**
 * Transclusion Tree View — native VS Code TreeView sidebar panel.
 *
 * Shows two collapsible groups for the currently active .tree file:
 *   • "Transcludes (N)" — files this tree references via \transclude, \import,
 *                         \export, or \ref.
 *   • "Transcluded by (N)" — files that reference the current tree the same way.
 *
 * Clicking a tree entry opens that .tree file in the editor.
 * The view refreshes automatically when the active editor changes.
 */
import * as vscode from 'vscode';
import * as path from 'path';

// Regex matching the four tree-reference commands; capture group 1 = tree ID
const TRANSCLUDE_RE = /\\(?:transclude|import|export|ref)\{([^}]+)\}/g;
// Regex for extracting the \title{...} text from a file
const TITLE_RE = /\\title\{([^}]+)\}/;

/** Extract the tree ID (filename stem) from an fsPath, or undefined if not a .tree file. */
function treeIdFromFsPath(fsPath: string): string | undefined {
    const basename = path.basename(fsPath);
    return basename.endsWith('.tree') ? basename.slice(0, -'.tree'.length) : undefined;
}

/** Read a TextDocument's text and return all transclude/import/export/ref target IDs. */
function extractRefs(text: string): Set<string> {
    const ids = new Set<string>();
    let m: RegExpExecArray | null;
    const re = new RegExp(TRANSCLUDE_RE.source, 'g');
    while ((m = re.exec(text)) !== null) {
        ids.add(m[1].trim());
    }
    return ids;
}

/** Extract the \title{...} value from a file's text, or undefined. */
function extractTitle(text: string): string | undefined {
    const m = TITLE_RE.exec(text);
    return m ? m[1].trim() : undefined;
}

// ── Data types ────────────────────────────────────────────────────────────────

type GroupNode = {
    readonly kind: 'group';
    readonly label: string;
    readonly children: EntryNode[];
};

type EntryNode = {
    readonly kind: 'entry';
    readonly treeId: string;
    readonly title: string | undefined;
    readonly fileUri: vscode.Uri | undefined;
};

type Node = GroupNode | EntryNode;

// ── Provider ──────────────────────────────────────────────────────────────────

export class TransclusionTreeProvider implements vscode.TreeDataProvider<Node> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private roots: GroupNode[] = [];

    /** Call when the active editor changes to refresh the view. */
    async update(document: vscode.TextDocument | undefined): Promise<void> {
        const currentId = document ? treeIdFromFsPath(document.uri.fsPath) : undefined;
        if (!currentId) {
            this.roots = [
                this.makeGroup('Transcludes', []),
                this.makeGroup('Transcluded by', []),
            ];
            this._onDidChangeTreeData.fire();
            return;
        }

        // Gather all .tree files in the workspace
        const allUris = await vscode.workspace.findFiles('**/*.tree');

        // Build a map: treeId → uri for quick lookup
        const uriByTreeId = new Map<string, vscode.Uri>();
        for (const uri of allUris) {
            const id = treeIdFromFsPath(uri.fsPath);
            if (id) {uriByTreeId.set(id, uri);}
        }

        // Read the current file's refs (outgoing)
        const currentUri = uriByTreeId.get(currentId);
        let outgoingIds: Set<string> = new Set();
        if (currentUri) {
            try {
                const doc = await vscode.workspace.openTextDocument(currentUri);
                outgoingIds = extractRefs(doc.getText());
            } catch {
                // file unreadable — skip
            }
        }

        // Scan all other files for incoming refs (they reference currentId)
        const incomingIds = new Set<string>();
        await Promise.all(
            allUris
                .filter(u => u.fsPath !== currentUri?.fsPath)
                .map(async uri => {
                    try {
                        const doc = await vscode.workspace.openTextDocument(uri);
                        if (extractRefs(doc.getText()).has(currentId)) {
                            const id = treeIdFromFsPath(uri.fsPath);
                            if (id) {incomingIds.add(id);}
                        }
                    } catch {
                        // skip unreadable files
                    }
                }),
        );

        // Build entry nodes, resolving titles
        const buildEntries = async (ids: Iterable<string>): Promise<EntryNode[]> => {
            const entries = await Promise.all(
                [...ids].sort().map(async (id): Promise<EntryNode> => {
                    const uri = uriByTreeId.get(id);
                    let title: string | undefined;
                    if (uri) {
                        try {
                            const doc = await vscode.workspace.openTextDocument(uri);
                            title = extractTitle(doc.getText());
                        } catch {
                            // skip
                        }
                    }
                    return { kind: 'entry', treeId: id, title, fileUri: uri };
                }),
            );
            return entries;
        };

        const [outgoingEntries, incomingEntries] = await Promise.all([
            buildEntries(outgoingIds),
            buildEntries(incomingIds),
        ]);

        this.roots = [
            this.makeGroup('Transcludes', outgoingEntries),
            this.makeGroup('Transcluded by', incomingEntries),
        ];
        this._onDidChangeTreeData.fire();
    }

    private makeGroup(label: string, children: EntryNode[]): GroupNode {
        return { kind: 'group', label: `${label} (${children.length})`, children };
    }

    getTreeItem(element: Node): vscode.TreeItem {
        if (element.kind === 'group') {
            const item = new vscode.TreeItem(
                element.label,
                element.children.length > 0
                    ? vscode.TreeItemCollapsibleState.Expanded
                    : vscode.TreeItemCollapsibleState.None,
            );
            item.iconPath = new vscode.ThemeIcon('list-tree');
            item.contextValue = 'transclusionGroup';
            return item;
        }

        const label = element.title
            ? `${element.treeId} — ${element.title}`
            : element.treeId;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('file-text');
        item.tooltip = element.title ?? element.treeId;
        item.contextValue = 'transclusionEntry';
        if (element.fileUri) {
            item.resourceUri = element.fileUri;
            item.command = {
                command: 'vscode.open',
                title: 'Open Tree',
                arguments: [element.fileUri],
            };
        }
        return item;
    }

    getChildren(element?: Node): Node[] {
        if (!element) {return this.roots;}
        if (element.kind === 'group') {return element.children;}
        return [];
    }
}
