/**
 * @fileoverview Barrel of every tool definition, in the order the server
 * registers them.
 * @module mcp-server/tools/definitions
 */

import { getAmendmentsTool } from './get-amendments.tool.js';
import { getDocumentTool } from './get-document.tool.js';
import { listReferenceTool } from './list-reference.tool.js';
import { lookupCitationTool } from './lookup-citation.tool.js';
import { searchLegislationTool } from './search-legislation.tool.js';
import { trackChangesTool } from './track-changes.tool.js';

export const allToolDefinitions = [
  searchLegislationTool,
  getDocumentTool,
  getAmendmentsTool,
  trackChangesTool,
  lookupCitationTool,
  listReferenceTool,
];
