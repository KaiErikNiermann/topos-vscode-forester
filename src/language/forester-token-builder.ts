/**
 * Custom Chevrotain token pattern for the `!{ … }` raw group.
 *
 * The body ends at the brace matching the opening one, and a regular expression
 * cannot count — so the terminal declared in forester.langium is a placeholder
 * and the real matcher is installed here.
 *
 * This mirrors forester's own lexer (Lexer.mll, the `raw` rule): a backslash
 * and the character after it are consumed together, so LaTeX's `\{`, `\}` and
 * `\\` neither open nor close a group.
 *
 * Chevrotain is not a direct dependency (it reaches us through Langium, and
 * pnpm's layout keeps it unresolvable from here), so the two shapes we touch
 * are described structurally rather than imported.
 */
import { DefaultTokenBuilder } from 'langium';
import type { Grammar, TokenBuilderOptions } from 'langium';
import { rawGroupEnd } from '../raw-group.js';

const RAW_GROUP_TOKEN = 'RAW_GROUP';

/** The parts of a Chevrotain TokenType this builder rewrites. */
interface PatchableTokenType {
    name: string;
    PATTERN?: unknown;
    LINE_BREAKS?: boolean;
    START_CHARS_HINT?: (string | number)[];
}

/**
 * Match `!{ … }` starting at `offset`, returning Chevrotain's custom-pattern
 * result (a RegExp-exec-shaped array holding the matched text) or null.
 *
 * Exported for direct testing: the brace arithmetic is the whole point of this
 * token, and driving it through the parser to check it is needlessly indirect.
 */
export function matchRawGroup(text: string, offset: number): RegExpExecArray | null {
    // Unterminated groups return null, which leaves the '!' to the ordinary
    // rules — the user gets a parse error there rather than the rest of the
    // file silently disappearing into one token.
    const end = rawGroupEnd(text, offset);
    if (end === null) { return null; }

    const result = [text.slice(offset, end)] as unknown as RegExpExecArray;
    result.index = offset;
    result.input = text;
    return result;
}

export class ForesterTokenBuilder extends DefaultTokenBuilder {
    override buildTokens(grammar: Grammar, options?: TokenBuilderOptions): ReturnType<DefaultTokenBuilder['buildTokens']> {
        const tokens = super.buildTokens(grammar, options);
        if (Array.isArray(tokens)) {
            const rawGroup = (tokens as PatchableTokenType[]).find((t) => t.name === RAW_GROUP_TOKEN);
            if (rawGroup) {
                rawGroup.PATTERN = matchRawGroup;
                // The body spans lines; Chevrotain needs telling so line and
                // column tracking stays correct for everything after it.
                rawGroup.LINE_BREAKS = true;
                // A custom pattern cannot be dispatched by first-character
                // lookup unless we say which characters can start it.
                rawGroup.START_CHARS_HINT = ['!'];
            }
        }
        return tokens;
    }
}
