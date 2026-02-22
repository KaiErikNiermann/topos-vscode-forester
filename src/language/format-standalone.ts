/**
 * Standalone Forester formatter bridge (task 21).
 *
 * Exposes formatDocument() so the VSCode extension provider and tests can use
 * the formatter without a running LSP connection.
 *
 * Implementation: delegates to formatter-core.ts (the hand-rolled formatter)
 * which handles all Forester syntax correctly — word joining, idempotence,
 * verbatim \startverb/\stopverb blocks, % comments, [[id]] wiki links,
 * [text](url) Markdown links, \<html:div> XML element names, etc.
 *
 * The Langium grammar (forester.langium) and ForesterFormatter (AbstractFormatter)
 * are still used for LSP features (validation, completions, hover).  But
 * for text formatting we use the hand-rolled formatter-core, which produces
 * correct output for the full Forester syntax.
 */
import { format } from '../formatter-core.js';

// ─── Config type (mirrors ForesterFormatterConfig in forester-formatter.ts) ──

export interface FormatConfig {
    ignoredCommands?: Set<string>;
    subtreeMacros?: Set<string>;
}

/**
 * Format a Forester source text.
 *
 * @param text          Raw .tree file content.
 * @param config        Optional ignoredCommands / subtreeMacros sets.
 * @param tabSize       Indentation width (default 2).
 * @param insertSpaces  Use spaces rather than tabs (default true).
 * @returns             Formatted text (as a resolved Promise).
 */
export async function formatDocument(
    text: string,
    config: Partial<FormatConfig> = {},
    tabSize = 2,
    insertSpaces = true,
): Promise<string> {
    return format(text, {
        tabSize,
        insertSpaces,
        ignoredCommands: config.ignoredCommands,
        subtreeMacros: config.subtreeMacros,
    });
}
