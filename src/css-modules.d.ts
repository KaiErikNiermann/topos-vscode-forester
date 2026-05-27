/**
 * `.css` files imported in this project are loaded by esbuild's `text` loader
 * and resolve to a string of the file's contents (not a stylesheet handle).
 */
declare module "*.css" {
    const css: string;
    export default css;
}
