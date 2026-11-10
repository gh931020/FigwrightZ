import { describe, expect, it } from 'vitest';

import { handleComponentHandoff } from '../../src/tools/get-component-handoff.js';

const componentSet = { id: '1:1', type: 'COMPONENT_SET', name: 'Button' };
const instance = { id: '1:2', type: 'INSTANCE', name: 'Save' };
const frame = { id: '1:3', type: 'FRAME', name: 'Imported control' };
const components = [
  {
    id: '2:1',
    name: 'State=Default, Size=Small',
    variantProperties: { State: 'Default', Size: 'Small' },
  },
  {
    id: '2:2',
    name: 'State=Disabled, Size=Large',
    variantProperties: { State: 'Disabled', Size: 'Large' },
  },
];

type Report = {
  target: { nodeId: string; type: string };
  design: { nodes: unknown[] };
  componentApi?: unknown;
  variants?: { nodeId: string; design?: unknown }[];
  missingExpectedValues?: Record<string, string>[];
  issues: { nodeId: string; message: string }[];
};

const fixture = ({ selection = [instance], broken = false, previewFails = false } = {}) => {
  const calls: { tool: string; args: unknown }[] = [];
  const run = async (args: unknown = {}) => {
    const result = await handleComponentHandoff(async (tool, params) => {
      calls.push({ tool, args: params });
      const { nodeId, nodeIds } = params as { nodeId?: string; nodeIds?: string[] };
      switch (tool) {
        case 'get_selection':
          return { nodes: selection };
        case 'get_design_context': {
          // The plugin distinguishes omitted depth from an explicitly invalid value.
          if (
            'depth' in (params as object) &&
            typeof (params as { depth: unknown }).depth !== 'number'
          ) {
            throw new Error('get_design_context: depth must be a non-negative number');
          }
          const node = [
            instance,
            frame,
            componentSet,
            ...components.map(c => ({ ...c, type: 'COMPONENT' })),
          ].find(candidate => candidate.id === nodeId);
          return { nodes: node === undefined ? [] : [{ ...node, width: 80 }] };
        }
        case 'get_component_api':
          if (broken) throw new Error('Component set has existing errors');
          return {
            ...componentSet,
            properties: { State: { type: 'VARIANT', defaultValue: 'Default' } },
          };
        case 'get_local_components':
          return {
            components: broken
              ? components.map(c => ({
                  ...c,
                  variantProperties: undefined,
                  componentSetError: 'Invalid set',
                }))
              : components,
            componentSets: [{ ...componentSet, componentIds: components.map(c => c.id) }],
          };
        case 'get_screenshot':
          if (previewFails) throw new Error('Render unavailable');
          return { images: nodeIds!.map(id => ({ nodeId: id, format: 'PNG', base64: 'cG5n' })) };
        default:
          throw new Error(`Unexpected tool ${tool}`);
      }
    }, args);
    const block = result.content[0]!;
    if (block.type !== 'text') throw new Error('Expected a report');
    return { report: JSON.parse(block.text) as Report, content: result.content };
  };
  return { run, calls };
};

describe('get_component_handoff', () => {
  it('reports the actual selected instance, its source API and defined combinations, with bounded previews', async () => {
    const { run, calls } = fixture();
    const { report, content } = await run({
      variantLimit: 1,
      expectedVariants: [{ State: 'Disabled' }, { State: 'Default', Size: 'Large' }],
    });
    expect(report).toMatchObject({
      target: { nodeId: instance.id, type: 'INSTANCE' },
      design: { nodes: [{ id: instance.id, width: 80 }] },
      componentApi: { id: componentSet.id },
      variants: [
        { nodeId: '2:1', design: { nodes: [{ id: '2:1', width: 80 }] } },
        { nodeId: '2:2', properties: { State: 'Disabled' } },
      ],
      missingExpectedValues: [{ State: 'Default', Size: 'Large' }],
    });
    expect(report.variants?.[1]?.design).toBeUndefined();
    expect(content.filter(block => block.type === 'image')).toHaveLength(2);
    expect(calls.at(-1)).toMatchObject({
      tool: 'get_screenshot',
      args: { nodeIds: [instance.id, '2:1'] },
    });
  });

  it('returns a plain frame without probing component APIs or exporting when previews are disabled', async () => {
    const { run, calls } = fixture();
    const { report } = await run({ nodeId: frame.id, includePreviews: false });
    expect(report).toMatchObject({
      target: { nodeId: frame.id },
      design: { nodes: [{ width: 80 }] },
    });
    expect(report.componentApi).toBeUndefined();
    expect(report.missingExpectedValues).toBeUndefined();
    expect(calls.map(call => call.tool)).toEqual(['get_design_context', 'get_design_context']);
  });

  it('keeps visual details when component properties and preview are unavailable', async () => {
    const { run } = fixture({ broken: true, previewFails: true });
    const { report } = await run({
      nodeId: componentSet.id,
      expectedVariants: [{ State: 'Loading' }],
    });
    expect(report.variants).toHaveLength(2);
    expect(report.design.nodes).toHaveLength(1);
    expect(report.missingExpectedValues).toBeUndefined();
    expect(report.issues.map(issue => issue.message)).toEqual([
      expect.stringContaining('Component set has existing errors'),
      expect.stringContaining('complete inventory'),
      expect.stringContaining('Render unavailable'),
    ]);
  });

  it.each([[], [instance, frame]])(
    'requires one selected layer when no node id is provided',
    async (...selection) => {
      const { run, calls } = fixture({ selection });
      await expect(run()).rejects.toThrow(/select exactly one layer/);
      expect(calls.map(call => call.tool)).toEqual(['get_selection']);
    },
  );
});
