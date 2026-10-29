/**
 * Host loader entry for the browser-only desktop-pet plugin.
 *
 * The Loader still mounts the package root before discovering the browser
 * entry declared by `dsh.client`, so the host half must be a valid plugin.
 * @module dsh-grokbot-pet
 */

/** Provides no host-side behavior. */
export function apply(): void {}
