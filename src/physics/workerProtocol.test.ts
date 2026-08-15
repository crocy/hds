import { describe, expect, it } from 'vitest';
import { toSolveErrorResponse } from './workerProtocol';
import { UnknownMaterialError } from './materials';

describe('toSolveErrorResponse', () => {
  it('keeps the message and name of a real error, so the UI can show what broke', () => {
    const response = toSolveErrorResponse(7, new UnknownMaterialError('made-up'));
    expect(response).toMatchObject({
      kind: 'error',
      requestId: 7,
      name: 'UnknownMaterialError',
    });
    expect(response.message).toMatch(/made-up/);
    expect(response.stack).toBeTruthy();
  });

  it('describes a thrown non-Error rather than posting "undefined"', () => {
    expect(toSolveErrorResponse(1, { weird: true }).message).toMatch(/Solver threw/);
    expect(toSolveErrorResponse(1, 'out of memory').message).toBe('out of memory');
    expect(toSolveErrorResponse(1, undefined).message).toMatch(/Solver threw undefined/);
  });

  it('never returns an empty message', () => {
    const response = toSolveErrorResponse(2, new Error(''));
    expect(response.message.length).toBeGreaterThan(0);
  });
});
