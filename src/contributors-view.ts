/**
 * Contributors sidebar view — native VS Code TreeView.
 *
 * For the currently active .tree file, shows the people who contributed
 * to it, based on Forester's built-in contributor relations:
 *
 *   • Direct Contributors  — listed via \author{personId} in the current tree
 *   • Indirect Contributors — authors of trees that are (transitively) transcluded
 *                              into the current tree, excluding direct contributors
 *
 * Each contributor entry shows "personId — Name" (name resolved from the
 * person's own .tree file title, if available).  Clicking opens their file.
 *
 * The view refreshes automatically whenever the active editor changes.
 */
import * as vscode from 'vscode';
import * as path from 'path';

// Regex for \author{personId} — one or more per file
const AUTHOR_RE = /\\author\{([^}]+)\}/g;
// Regex for all transclusion-style commands; captures the tree ID
const TRANSCLUDE_RE = /\\(?:transclude|import|export)\{([^}]+)\}/g;
// Regex for \title{...}
const TITLE_RE = /\\title\{([^}]+)\}/;

// ── Helpers ───────────────────────────────────────────────────────────────────

function treeIdFromFsPath(fsPath: string): string | undefined {
    const basename = path.basename(fsPath);
    return basename.endsWith('.tree') ? basename.slice(0, -5) : undefined;
}

function extractAuthors(text: string): Set<string> {
    const ids = new Set<string>();
    let m: RegExpExecArray | null;
    const re = new RegExp(AUTHOR_RE.source, 'g');
    while ((m = re.exec(text)) !== null) {
        ids.add(m[1].trim());
    }
    return ids;
}

function extractTranscludeTargets(text: string): Set<string> {
    const ids = new Set<string>();
    let m: RegExpExecArray | null;
    const re = new RegExp(TRANSCLUDE_RE.source, 'g');
    while ((m = re.exec(text)) !== null) {
        ids.add(m[1].trim());
    }
    return ids;
}

function extractTitle(text: string): string | undefined {
    const m = TITLE_RE.exec(text);
    return m ? m[1].trim() : undefined;
}

// ── Node types ────────────────────────────────────────────────────────────────

type GroupNode = {
    readonly kind: 'group';
    readonly label: string;
    readonly tooltip: string;
    readonly children: PersonNode[];
};

type PersonNode = {
    readonly kind: 'person';
    readonly personId: string;
    readonly displayName: string | undefined;
    readonly fileUri: vscode.Uri | undefined;
};

type Node = GroupNode | PersonNode;

// ── Provider ──────────────────────────────────────────────────────────────────

export class ContributorsTreeProvider implements vscode.TreeDataProvider<Node> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private roots: GroupNode[] = [];

    /** Call when the active editor changes. */
    async update(document: vscode.TextDocument | undefined): Promise<void> {
        const currentId = document ? treeIdFromFsPath(document.uri.fsPath) : undefined;
        if (!currentId) {
            this.roots = [];
            this._onDidChangeTreeData.fire();
            return;
        }

        const allUris = await vscode.workspace.findFiles('**/*.tree');

        // Index: treeId → { uri, text }
        const treeIndex = new Map<string, { uri: vscode.Uri; text: string }>();
        await Promise.all(
            allUris.map(async uri => {
                const id = treeIdFromFsPath(uri.fsPath);
                if (!id) return;
                try {
                    const doc = await vscode.workspace.openTextDocument(uri);
                    treeIndex.set(id, { uri, text: doc.getText() });
                } catch {
                    // skip unreadable files
                }
            }),
        );

        // Step 1: direct contributors from the current tree
        const currentEntry = treeIndex.get(currentId);
        const directIds: Set<string> = currentEntry
            ? extractAuthors(currentEntry.text)
            : new Set();

        // Step 2: BFS to collect all transitively transcluded tree IDs
        const transcludedIds = new Set<string>();
        const queue: string[] = [currentId];
        const visited = new Set<string>([currentId]);
        while (queue.length > 0) {
            const id = queue.shift()!;
            const entry = treeIndex.get(id);
            if (!entry) continue;
            for (const targetId of extractTranscludeTargets(entry.text)) {
                if (!visited.has(targetId)) {
                    visited.add(targetId);
                    transcludedIds.add(targetId);
                    queue.push(targetId);
                }
            }
        }

        // Step 3: indirect contributors = authors of transcluded trees, not already direct
        const indirectIds = new Set<string>();
        for (const tid of transcludedIds) {
            const entry = treeIndex.get(tid);
            if (!entry) continue;
            for (const personId of extractAuthors(entry.text)) {
                if (!directIds.has(personId)) {
                    indirectIds.add(personId);
                }
            }
        }

        // Step 4: resolve person names from their own .tree files
        const resolvePerson = (personId: string): PersonNode => {
            const entry = treeIndex.get(personId);
            return {
                kind: 'person',
                personId,
                displayName: entry ? extractTitle(entry.text) : undefined,
                fileUri: entry?.uri,
            };
        };

        const directNodes = [...directIds].sort().map(resolvePerson);
        const indirectNodes = [...indirectIds].sort().map(resolvePerson);

        this.roots = [];

        if (directNodes.length > 0) {
            this.roots.push({
                kind: 'group',
                label: `Direct Contributors (${directNodes.length})`,
                tooltip: 'People listed via \\author{…} in this tree',
                children: directNodes,
            });
        }

        if (indirectNodes.length > 0) {
            this.roots.push({
                kind: 'group',
                label: `Indirect Contributors (${indirectNodes.length})`,
                tooltip: 'Authors of transitively transcluded trees',
                children: indirectNodes,
            });
        }

        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: Node): vscode.TreeItem {
        if (element.kind === 'group') {
            const item = new vscode.TreeItem(
                element.label,
                vscode.TreeItemCollapsibleState.Expanded,
            );
            item.tooltip = element.tooltip;
            item.iconPath = new vscode.ThemeIcon('account');
            item.contextValue = 'contributorGroup';
            return item;
        }

        // PersonNode
        const label = element.displayName
            ? `${element.personId} — ${element.displayName}`
            : element.personId;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('person');
        item.tooltip = element.displayName ?? element.personId;
        item.contextValue = 'contributorPerson';

        if (element.fileUri) {
            item.resourceUri = element.fileUri;
            item.command = {
                command: 'vscode.open',
                title: 'Open Contributor Tree',
                arguments: [element.fileUri],
            };
        }

        return item;
    }

    getChildren(element?: Node): Node[] {
        if (!element) return this.roots;
        if (element.kind === 'group') return element.children;
        return [];
    }
}
