import type { AppRequestHandler } from '../../src';

/*
 * A Next.js app route as the README mounts the handler:
 * `export const POST = answers`. test/types/next-route.ts runs Next's own
 * check of a route file against this module.
 */
declare const answers: AppRequestHandler;

export const POST = answers;
