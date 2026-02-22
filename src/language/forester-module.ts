import type { LangiumServices, LangiumSharedServices, Module, PartialLangiumServices } from 'langium/lsp';
import { createDefaultModule, createDefaultSharedModule, DefaultSharedModuleContext } from 'langium/lsp';
import { ForesterGeneratedModule, ForesterGeneratedSharedModule } from './generated/module.js';

/**
 * Union type of all services provided by the Forester language module.
 * Additional services (formatter, hover provider, etc.) will be added here
 * as they are migrated from hand-rolled implementations (tasks 15-27).
 */
export type ForesterAddedServices = {
    // Reserved for future Forester-specific services
};

/**
 * The combined type of all services provided by this module.
 */
export type ForesterServices = LangiumServices & ForesterAddedServices;

/**
 * Dependency-injection module for Forester-specific services.
 * Register custom formatter and hover providers here once implemented
 * (see tasks 15, 20, 23-26).
 */
export const ForesterModule: Module<ForesterServices, PartialLangiumServices & ForesterAddedServices> = {
    // lsp: {
    //   Formatter: (services) => new ForesterFormatter(services),
    //   HoverProvider: (services) => new ForesterHoverProvider(services),
    // }
};

/**
 * Create the full set of Langium services for the Forester language.
 * Called from main.ts (language server) and from extension.ts (embedding).
 */
export function createForesterServices(context: DefaultSharedModuleContext): {
    shared: LangiumSharedServices;
    Forester: ForesterServices;
} {
    const shared = createDefaultSharedModule(context, ForesterGeneratedSharedModule);
    const Forester = createDefaultModule({ shared }, ForesterGeneratedModule, ForesterModule);
    return { shared, Forester };
}
