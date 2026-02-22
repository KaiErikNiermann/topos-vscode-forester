/**
 * Backlinks and References sidebar view — native VS Code TreeView.
 *
 * For the currently active .tree file, shows every workspace file that
 * references it, grouped by command type:
 *
 *   • Transcludes    — \transclude{currentId}
 *   • Imports        — \import{currentId}
 *   • Exports        — \export{currentId}
 *   • References     — \ref{currentId}
 *   • Wiki-links     — [[currentId]] or [[currentId|text]]
 *
 * Each reference entry shows the referencing tree ID + title and, beneath
 * it, the context line from the source file.  Clicking a reference entry
 * opens the source file at the matching line.
 *
 * The view refreshes automatically whenever the active editor changes.
 */
import * as vscode from 'vscode';
import * as path from 'path';

// ── Reference discovery ───────────────────────────────────────────────────────

type RefKind = 'transclude' | 'import' | 'export' | 'ref' | 'wikilink';

const REF_PATTERNS: Readonly<Record<RefKind, RegExp>> = {
    transclude: /\\transclude\{([^}]+)\}/g,
    import:     /\\import\{([^}]+)\}/g,
    export:     /\\export\{([^}]+)\}/g,
    ref:        /\\ref\{([^}]+)\}/g,
    wikilink:   /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g,
};

interface RawRef {
    kind: RefKind;
    line: number;          // 0-based line number in source file
    lineText: string;      // trimmed source line
}

/** Return all references to `targetId` found in `text`, by kind and line. */
function findRefsToTarget(text: string, targetId: string): RawRef[] {
    const lines = text.split('\n');
    const results: RawRef[] = [];

    for (const [kind, re] of Object.entries(REF_PATTERNS) as [RefKind, RegExp][]) {
        const pattern = new RegExp(re.source, 'g');
        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            const lineText = lines[lineIdx];
            let m: RegExpExecArray | null;
            while ((m = pattern.exec(lineText)) !== null) {
                if (m[1].trim() === targetId) {
                    results.push({ kind, line: lineIdx, lineText: lineText.trim() });
                }
            }
        }
    }

    return results;
}

/** Extract \title{...} from file text, or undefined. */
function extractTitle(text: string): string | undefined {
    const m = /\\title\{([^}]+)\}/.exec(text);
    return m ? m[1].trim() : undefined;
}

/** Extract tree ID (filename stem) from fsPath, or undefined if not .tree. */
function treeIdFromFsPath(fsPath: string): string | undefined {
    const basename = path.basename(fsPath);
    return basename.endsWith('.tree') ? basename.slice(0, -5) : undefined;
}

// ── Node types ────────────────────────────────────────────────────────────────

type GroupNode = {
    readonly kind: 'group';
    readonly refKind: RefKind;
    readonly label: string;
    readonly children: FileNode[];
};

type FileNode = {
    readonly kind: 'file';
    readonly treeId: string;
    readonly title: string | undefined;
    readonly fileUri: vscode.Uri;
    readonly refs: RefLineNode[];
};

type RefLineNode = {
    readonly kind: 'line';
    readonly fileUri: vscode.Uri;
    readonly line: number;       // 0-based
    readonly lineText: string;
};

type Node = GroupNode | FileNode | RefLineNode;

// ── Label constants ───────────────────────────────────────────────────────────

const GROUP_LABELS: Readonly<Record<RefKind, string>> = {
    transclude: 'Transcludes',
    import:     'Imports',
    export:     'Exports',
    ref:        'References',
    wikilink:   'Wiki-links',
};

const GROUP_ICONS: Readonly<Record<RefKind, string>> = {
    transclude: 'type-hierarchy-sub',
    import:     'arrow-down',
    export:     'arrow-up',
    ref:        'link',
    wikilink:   'bracket',
};

// ── Provider ──────────────────────────────────────────────────────────────────

export class BacklinksTreeProvider implements vscode.TreeDataProvider<Node> {
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

        // Scan every other .tree file for references to currentId
        const refsByKind = new Map<RefKind, Map<string, { uri: vscode.Uri; title: string | undefined; refs: RawRef[] }>>();
        for (const k of Object.keys(REF_PATTERNS) as RefKind[]) {
            refsByKind.set(k, new Map());
        }

        await Promise.all(
            allUris
                .filter(u => treeIdFromFsPath(u.fsPath) !== currentId)
                .map(async uri => {
                    try {
                        const doc = await vscode.workspace.openTextDocument(uri);
                        const text = doc.getText();
                        const rawRefs = findRefsToTarget(text, currentId);
                        if (rawRefs.length === 0) return;

                        const srcId = treeIdFromFsPath(uri.fsPath) ?? uri.fsPath;
                        const title = extractTitle(text);

                        for (const raw of rawRefs) {
                            const bucket = refsByKind.get(raw.kind)!;
                            if (!bucket.has(srcId)) {
                                bucket.set(srcId, { uri, title, refs: [] });
                            }
                            bucket.get(srcId)!.refs.push(raw);
                        }
                    } catch {
                        // skip unreadable files
                    }
                }),
        );

        // Build the group nodes (only include groups that have results)
        const groups: GroupNode[] = [];
        for (const k of Object.keys(REF_PATTERNS) as RefKind[]) {
            const bucket = refsByKind.get(k)!;
            if (bucket.size === 0) continue;

            const fileNodes: FileNode[] = [...bucket.entries()]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([srcId, { uri, title, refs }]): FileNode => ({
                    kind: 'file',
                    treeId: srcId,
                    title,
                    fileUri: uri,
                    refs: refs.map((r): RefLineNode => ({
                        kind: 'line',
                        fileUri: uri,
                        line: r.line,
                        lineText: r.lineText,
                    })),
                }));

            groups.push({
                kind: 'group',
                refKind: k,
                label: `${GROUP_LABELS[k]} (${fileNodes.length})`,
                children: fileNodes,
            });
        }

        this.roots = groups;
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: Node): vscode.TreeItem {
        if (element.kind === 'group') {
            const item = new vscode.TreeItem(
                element.label,
                vscode.TreeItemCollapsibleState.Expanded,
            );
            item.iconPath = new vscode.ThemeIcon(GROUP_ICONS[element.refKind]);
            item.contextValue = 'backlinkGroup';
            return item;
        }

        if (element.kind === 'file') {
            const label = element.title
                ? `${element.treeId} — ${element.title}`
                : element.treeId;
            const item = new vscode.TreeItem(
                label,
                element.refs.length > 0
                    ? vscode.TreeItemCollapsibleState.Collapsed
                    : vscode.TreeItemCollapsibleState.None,
            );
            item.iconPath = new vscode.ThemeIcon('file-text');
            item.tooltip = element.title ?? element.treeId;
            item.resourceUri = element.fileUri;
            item.command = {
                command: 'vscode.open',
                title: 'Open Tree',
                arguments: [element.fileUri],
            };
            item.contextValue = 'backlinkFile';
            return item;
        }

        // RefLineNode — context line
        const item = new vscode.TreeItem(element.lineText, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('symbol-string');
        item.tooltip = element.lineText;
        item.command = {
            command: 'vscode.open',
            title: 'Go to Reference',
            arguments: [
                element.fileUri,
                {
                    selection: new vscode.Range(
                        new vscode.Position(element.line, 0),
                        new vscode.Position(element.line, element.lineText.length),
                    ),
                } satisfies vscode.TextDocumentShowOptions,
            ],
        };
        item.contextValue = 'backlinkLine';
        return item;
    }

    getChildren(element?: Node): Node[] {
        if (!element) return this.roots;
        if (element.kind === 'group') return element.children;
        if (element.kind === 'file') return element.refs;
        return [];
    }
}
