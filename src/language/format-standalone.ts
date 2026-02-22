/**
 * Standalone Langium formatter bridge (task 21).
 *
 * Exposes formatDocument() so the VSCode extension provider and tests can use
 * the Langium-backed ForesterFormatter without a running LSP connection.
 *
 * Services are created once (lazily) with EmptyFileSystem so no Node file-
 * system or LSP connection is required.
 */
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ForesterFormatter, type ForesterFormatterConfig } from './forester-formatter.js';
import { createForesterServices } from './forester-module.js';

// Lazily created services + helpers (shared across calls for efficiency).
let _services: ReturnType<typeof createForesterServices>['Forester'] | undefined;
let _parse: ReturnType<typeof parseHelper> | undefined;

function getServices() {
    if (!_services) {
        const { Forester } = createForesterServices(EmptyFileSystem);
        _services = Forester;
        _parse = parseHelper(_services);
    }
    return { services: _services, parse: _parse! };
}

/**
 * Format a Forester source text using the Langium AbstractFormatter.
 *
 * @param text          Raw .tree file content.
 * @param config        Optional ignoredCommands / subtreeMacros sets.
 * @param tabSize       Indentation width (default 2).
 * @param insertSpaces  Use spaces rather than tabs (default true).
 * @returns             Formatted text.
 */
export async function formatDocument(
    text: string,
    config: Partial<ForesterFormatterConfig> = {},
    tabSize = 2,
    insertSpaces = true,
): Promise<string> {
    const { services, parse } = getServices();

    // Inject user config into the formatter.
    const fmt = services.lsp.Formatter;
    if (fmt instanceof ForesterFormatter) {
        fmt.setConfig(config);
    }

    const document = await parse(text);
    const identifier = { uri: document.uri.toString() };
    const options = { insertSpaces, tabSize };

    const edits = await fmt?.formatDocument(document, { textDocument: identifier, options }) ?? [];
    return TextDocument.applyEdits(document.textDocument, edits);
}
