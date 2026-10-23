import type { Ctx } from '../../dashboard/sprites.js';

/** A canvas context that only has the members a test gives it, for drawing code that touches no others. */
export const fakeCtx = (members: Partial<CanvasRenderingContext2D>): Ctx => members as Ctx;
