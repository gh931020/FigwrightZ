import {
  DESIGN_CONTEXT_TOKEN_BUDGET,
  estimateResultTokens,
  type GetComponentApiResult,
  type GetDesignContextResult,
  type GetLocalComponentsResult,
  type GetScreenshotResult,
  type GetSelectionResult,
} from '@figwright/shared';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { handleDesignContext } from './design-context-guard.js';
import type { ToolDispatcher } from './design-diff.js';
import { GET_COMPONENT_API_TOOL_NAME } from './get-component-api.js';
import { GET_DESIGN_CONTEXT_TOOL_NAME } from './get-design-context.js';
import { GET_LOCAL_COMPONENTS_TOOL_NAME } from './get-local-components.js';
import { GET_SCREENSHOT_TOOL_NAME, screenshotContent } from './get-screenshot.js';
import { GET_SELECTION_TOOL_NAME } from './get-selection.js';
import type { ToolSpec } from './spec.js';

export const GET_COMPONENT_HANDOFF_TOOL_NAME = 'get_component_handoff';

const inputSchema = z.object({
  nodeId: z
    .string()
    .optional()
    .describe('Component, instance, or frame id. Omit for one selected layer.'),
  variantLimit: z
    .number()
    .int()
    .min(0)
    .max(4)
    .optional()
    .describe(
      'Maximum variants with detailed specs and previews (default 3). The inventory is still returned.',
    ),
  includePreviews: z.boolean().optional().describe('Include PNG previews (default true).'),
  expectedVariants: z
    .array(z.record(z.string(), z.string()))
    .max(20)
    .optional()
    .describe(
      'Optional expected assignments using exact Figma axis names and values, e.g. [{ State: "Loading" }]. Partial assignments match any variant with those values.',
    ),
});

export const getComponentHandoffTool: ToolSpec = {
  name: GET_COMPONENT_HANDOFF_TOOL_NAME,
  description:
    'Read one Figma component, instance, or ordinary frame for implementation. Returns the selected ' +
    'node’s layout, styling, typography, variable bindings and annotations, its source component API ' +
    'and defined variant combinations when available, and labelled previews. Only caller-supplied ' +
    'expectedVariants are checked for absence. A plain frame still returns its design; unavailable ' +
    'properties or omitted detail are reported explicitly. Read-only; does not switch instance states.',
  inputSchema,
  kind: 'local',
  serverOnlyArgs: null,
};

interface Target {
  nodeId: string;
  name: string;
  type: string;
}

interface Variant extends Target {
  properties?: Record<string, string> | undefined;
  error?: string | undefined;
  design?: GetDesignContextResult;
}

interface Handoff {
  target: Target;
  design: GetDesignContextResult;
  componentApi?: GetComponentApiResult | undefined;
  variants?: Variant[] | undefined;
  missingExpectedValues?: Record<string, string>[];
  issues: { nodeId: string; message: string }[];
}

const identify = (node: { id: string; name: string; type: string }): Target => ({
  nodeId: node.id,
  name: node.name,
  type: node.type,
});

const readTarget = async (dispatch: ToolDispatcher, nodeId?: string): Promise<Target> => {
  if (nodeId === undefined) {
    const { nodes } = (await dispatch(GET_SELECTION_TOOL_NAME, {})) as GetSelectionResult;
    if (nodes.length !== 1) {
      throw new Error('get_component_handoff: select exactly one layer or pass its nodeId.');
    }
    return identify(nodes[0]!);
  }
  const { nodes } = (await dispatch(GET_DESIGN_CONTEXT_TOOL_NAME, {
    nodeId,
    detail: 'minimal',
    depth: 1,
  })) as GetDesignContextResult;
  if (nodes.length !== 1) throw new Error(`get_component_handoff: could not read node ${nodeId}.`);
  return identify(nodes[0]!);
};

const readVariants = async (dispatch: ToolDispatcher, ownerId: string): Promise<Variant[]> => {
  const { components, componentSets } = (await dispatch(GET_LOCAL_COMPONENTS_TOOL_NAME, {
    nodeId: ownerId,
  })) as GetLocalComponentsResult;
  const set = componentSets.find(candidate => candidate.id === ownerId);
  if (set === undefined) throw new Error('The source component set was not returned.');
  const byId = new Map(components.map(component => [component.id, component]));
  return set.componentIds.map(id => {
    const variant = byId.get(id);
    return {
      nodeId: id,
      name: variant?.name ?? id,
      type: 'COMPONENT',
      properties: variant?.variantProperties,
      error:
        variant?.componentSetError ??
        (variant === undefined ? 'Variant could not be read.' : undefined),
    };
  });
};

export const handleComponentHandoff = async (
  dispatch: ToolDispatcher,
  rawArgs: unknown,
): Promise<CallToolResult> => {
  const args = inputSchema.parse(rawArgs);
  const target = await readTarget(dispatch, args.nodeId);
  const { nodeId, type } = target;
  const readDesign = (id: string, depth?: number) =>
    handleDesignContext(dispatch, depth === undefined ? { nodeId: id } : { nodeId: id, depth });
  const report: Handoff = {
    target,
    design: await readDesign(nodeId, type === 'COMPONENT_SET' ? 1 : undefined),
    issues: [],
  };
  const addIssue = (id: string, message: string): void => {
    report.issues.push({ nodeId: id, message });
  };
  const optional = async <T>(
    id: string,
    label: string,
    read: () => Promise<T>,
  ): Promise<T | undefined> => {
    try {
      return await read();
    } catch (error) {
      addIssue(id, `${label}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };

  const component = type === 'COMPONENT_SET' || type === 'COMPONENT' || type === 'INSTANCE';
  if (component) {
    report.componentApi = await optional(
      nodeId,
      'Component properties unavailable',
      async () =>
        (await dispatch(GET_COMPONENT_API_TOOL_NAME, { nodeId })) as GetComponentApiResult,
    );
  } else {
    addIssue(
      nodeId,
      'This layer has visual specifications but no Figma component API or declared variants.',
    );
  }
  const ownerId =
    type === 'COMPONENT_SET'
      ? nodeId
      : report.componentApi?.type === 'COMPONENT_SET'
        ? report.componentApi.id
        : undefined;
  if (ownerId !== undefined) {
    report.variants = await optional(ownerId, 'Variant inventory unavailable', () =>
      readVariants(dispatch, ownerId),
    );
  }

  const variants = report.variants ?? [];
  if (args.expectedVariants?.length) {
    if (variants.length === 0 || variants.some(variant => variant.properties === undefined)) {
      addIssue(nodeId, 'Expected variants could not be checked against a complete inventory.');
    } else {
      report.missingExpectedValues = args.expectedVariants.filter(
        expected =>
          !variants.some(variant =>
            Object.entries(expected).every(
              ([axis, value]) =>
                Object.hasOwn(variant.properties!, axis) && variant.properties![axis] === value,
            ),
          ),
      );
    }
  }

  const detailed = variants.slice(0, args.variantLimit ?? 3);
  if (variants.length > detailed.length) {
    addIssue(
      ownerId ?? nodeId,
      `Detailed design and previews are limited to ${detailed.length} of ${variants.length} variants. Pass another variant's nodeId to inspect it.`,
    );
  }
  for (const variant of detailed) {
    if (variant.nodeId === nodeId) continue; // The selected variant already has its full design above.
    // eslint-disable-next-line no-await-in-loop -- bound serializations and retain variant order
    const design = await optional(variant.nodeId, 'Variant design unavailable', () =>
      readDesign(variant.nodeId),
    );
    if (design === undefined) continue;
    variant.design = design;
    if (estimateResultTokens(JSON.stringify(report)) > DESIGN_CONTEXT_TOKEN_BUDGET) {
      delete variant.design;
      addIssue(
        variant.nodeId,
        'Variant detail exceeded the report budget. Read this node separately.',
      );
    }
  }

  const previewIds = [
    ...new Set([
      ...(type === 'COMPONENT_SET' && detailed.length > 0 ? [] : [nodeId]),
      ...detailed.map(variant => variant.nodeId),
    ]),
  ];
  const previews =
    args.includePreviews === false
      ? undefined
      : await optional(
          nodeId,
          'Previews unavailable',
          async () =>
            (await dispatch(GET_SCREENSHOT_TOOL_NAME, {
              nodeIds: previewIds,
              format: 'PNG',
              forVision: true,
            })) as GetScreenshotResult,
        );
  return {
    content: [
      { type: 'text', text: JSON.stringify(report) },
      ...(previews === undefined ? [] : screenshotContent(previews, 2 * 1024 * 1024)),
    ],
  };
};
