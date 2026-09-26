/**
 * @fileoverview Tests for uklaw_list_reference: every topic on both surfaces,
 * no upstream request, and schema rejection of an unknown topic.
 * @module tests/mcp-server/tools/definitions/list-reference.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { REFERENCE_TOPICS, referenceEntries } from '@/services/legislation/reference-data.js';
import { contentText, createUpstream, errorOf, type Upstream } from '../../../helpers/upstream.js';

let up: Upstream;

beforeEach(() => {
  up = createUpstream([]);
});

describe('uklaw_list_reference', () => {
  it.each(REFERENCE_TOPICS)(
    'returns topic %s on both surfaces without a request',
    async (topic) => {
      const result = await runToolContract(listReferenceTool, { topic });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ topic, entries: referenceEntries(topic) });
      const text = contentText(result);
      expect(text).toContain(`## Reference: ${topic}`);
      expect(text).toContain('| Key | Label | Description | Details |');
      for (const entry of referenceEntries(topic)) {
        expect(text).toContain(
          entry.key.replace(/\|/g, '\\|').replace(/[*`[\]]/g, (c) => `\\${c}`),
        );
      }
      expect(up.paths()).toEqual([]);
    },
  );

  it('renders type details as name: value pairs', async () => {
    const text = contentText(await runToolContract(listReferenceTool, { topic: 'types' }));
    expect(text).toMatch(
      /\| eur \| Regulations originating from the EU \|.*\| document_main_type: EuropeanUnionRegulation; category: eu-origin;.*enacted_keyword: adopted \|/,
    );
  });

  it('is marked closed-world and read-only', () => {
    expect(listReferenceTool.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it.each(['', 'statutes', 'TYPES'])('rejects topic %j at the schema', async (topic) => {
    const error = errorOf(await runToolContract(listReferenceTool, { topic } as never));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
  });
});
