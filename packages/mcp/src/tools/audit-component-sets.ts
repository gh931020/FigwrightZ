import { z } from 'zod';

import type { ToolSpec } from './spec.js';

export const auditComponentSetsTool: ToolSpec = {
  name: 'audit_component_sets',
  description:
    'Read-only audit for component sets Figma reports as invalid. Scans the selection and its ' +
    'descendants, or the current page if nothing is selected. You can force either scope. ' +
    'Returns the source sets, affected instances within scope, variant findings and repair hints. ' +
    'A referenced source set can be outside the scan scope. Instances whose source cannot be ' +
    'resolved and other read failures are listed separately. In Dev Mode, hidden layers inside ' +
    'instances may be skipped. For a large page, select smaller subtrees and audit those.',
  inputSchema: z.object({
    scope: z
      .enum(['selection', 'current_page'])
      .optional()
      .describe('Defaults to the selection if present, otherwise the current page'),
  }),
  kind: 'read',
};
