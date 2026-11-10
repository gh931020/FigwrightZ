import { AuditComponentSetsResultSchema } from '@figwright/shared';
import { describe, expect, it, vi } from 'vitest';

import { createAuditComponentSetsHandler } from '../../src/handlers/audit-component-sets.js';

const setError = 'Component set has existing errors';
const instanceError = 'Component set for node has existing errors';

const makeSet = (
  id: string,
  variants: { name: string; properties?: Record<string, string> }[],
  { error = setError, remote = false } = {},
) => {
  const set = {
    id,
    name: `Set ${id}`,
    type: 'COMPONENT_SET',
    remote,
    get variantGroupProperties() {
      if (error !== '') throw new Error(`in get_variantGroupProperties: ${error}`);
      return {};
    },
  };
  return Object.assign(set, {
    children: variants.map(({ name, properties }, index) => ({
      id: `${id}:${index}`,
      type: 'COMPONENT',
      name,
      parent: set,
      get variantProperties() {
        if (properties === undefined) throw new Error(`in get_variantProperties: ${instanceError}`);
        return properties;
      },
    })),
  });
};

const makeInstance = (
  id: string,
  main: object | null,
  { error = instanceError, children = [] as object[] } = {},
) => ({
  id,
  name: `Instance ${id}`,
  type: 'INSTANCE',
  children,
  get componentProperties() {
    if (error !== '') throw new Error(`in get_componentProperties: ${error}`);
    return {};
  },
  getMainComponentAsync: vi.fn<() => Promise<object | null>>(async () => main),
});

const makeAudit = (children: object[], selection: object[] = [], editorType = 'figma') => {
  const loadAllPagesAsync = vi.fn<() => Promise<void>>();
  const figmaCtx = {
    editorType,
    currentPage: { id: 'P:1', children, selection },
    skipInvisibleInstanceChildren: editorType === 'dev',
    loadAllPagesAsync,
  } as unknown as typeof figma;
  const handler = createAuditComponentSetsHandler(figmaCtx);
  return {
    run: async (scope?: string) => AuditComponentSetsResultSchema.parse(await handler({ scope })),
    loadAllPagesAsync,
  };
};

describe('audit_component_sets', () => {
  it('defaults to the selection, includes nested instances, and deduplicates overlapping roots', async () => {
    const set = makeSet(
      'S:1',
      [{ name: 'Size=M, State=Default' }, { name: 'State=Default, Size=M' }, { name: 'Size=L' }],
      { remote: true },
    );
    const nested = makeInstance('I:1', set.children[0]!);
    const outer = makeInstance('I:2', null, { error: '', children: [nested] });
    const outside = makeInstance('I:3', set.children[1]!);
    const audit = makeAudit([outer, outside], [outer, nested]);

    const result = await audit.run();
    expect(result.scope).toBe('selection');
    expect(result.componentSets).toMatchObject([
      {
        nodeId: 'S:1',
        remote: true,
        error: instanceError,
        affectedInstances: [{ nodeId: 'I:1', name: 'Instance I:1' }],
        variantFindings: [
          {
            kind: 'duplicate_variant_values',
            source: 'variant_names',
            variants: [{ nodeId: 'S:1:0' }, { nodeId: 'S:1:1' }],
          },
          {
            kind: 'inconsistent_variant_properties',
            source: 'variant_names',
            variants: [{ nodeId: 'S:1:0' }, { nodeId: 'S:1:1' }, { nodeId: 'S:1:2' }],
          },
        ],
      },
    ]);
    expect(result.componentSets[0]?.repairHints[0]).toContain('publish the library');
    expect(nested.getMainComponentAsync).toHaveBeenCalledTimes(1);
    expect(outer.getMainComponentAsync).not.toHaveBeenCalled();
    expect(outside.getMainComponentAsync).not.toHaveBeenCalled();
    expect(audit.loadAllPagesAsync).not.toHaveBeenCalled();
  });

  it('scans the current page by default when selection is empty, or when explicitly requested', async () => {
    const broken = makeSet('S:1', [
      { name: 'Variant A', properties: { Size: 'M', State: 'Default' } },
      { name: 'Variant B', properties: { State: 'Default', Size: 'M' } },
    ]);
    const noInstances = makeSet('S:2', [{ name: 'Invalid name' }]);
    const healthy = makeSet('S:3', [{ name: 'Size=M', properties: { Size: 'M' } }], { error: '' });
    const one = makeInstance('I:1', broken.children[0]!);
    const two = makeInstance('I:2', broken.children[1]!);
    const goodInstance = makeInstance('I:3', healthy.children[0]!, { error: '' });
    const page = [broken, noInstances, healthy, one, two, goodInstance];

    const result = await makeAudit(page).run();
    expect(result).toMatchObject({
      scope: 'current_page',
      pageId: 'P:1',
      componentSets: [
        {
          nodeId: 'S:1',
          error: setError,
          affectedInstances: [{ nodeId: 'I:1' }, { nodeId: 'I:2' }],
          variantFindings: [{ kind: 'duplicate_variant_values', source: 'variant_properties' }],
        },
        { nodeId: 'S:2', affectedInstances: [], variantFindings: [] },
      ],
      unreadableNodes: [],
      unresolvedInstances: [],
    });
    expect(result.componentSets[1]?.repairHints).toHaveLength(3);
    expect(await makeAudit(page, [goodInstance]).run('current_page')).toEqual(result);
    expect(goodInstance.getMainComponentAsync).not.toHaveBeenCalled();
  });

  it('checks the parent set when only one of its variants is selected', async () => {
    const set = makeSet('S:1', [{ name: 'Size=M' }, { name: 'Size=M' }]);
    const result = await makeAudit([set], [set.children[0]!]).run('selection');
    expect(result.componentSets).toMatchObject([
      {
        nodeId: 'S:1',
        affectedInstances: [],
        variantFindings: [{ kind: 'duplicate_variant_values' }],
      },
    ]);
  });

  it('separates confirmed failures without a source from unrelated read errors', async () => {
    const missing = makeInstance('I:1', null);
    const blocked = makeInstance('I:2', null);
    blocked.getMainComponentAsync.mockRejectedValueOnce('Library unavailable');
    const unreadable = makeInstance('I:3', null, { error: 'Node is unavailable' });
    const set = makeSet('S:1', [], { error: 'Unable to read this node' });
    const result = await makeAudit([missing, blocked, unreadable, set], [], 'dev').run();

    expect(result).toMatchObject({
      skipsInvisibleInstanceChildren: true,
      componentSets: [],
      unresolvedInstances: [
        { nodeId: 'I:1', error: instanceError, reason: 'Figma did not return a main component.' },
        { nodeId: 'I:2', error: instanceError, reason: 'Library unavailable' },
      ],
      unreadableNodes: [
        { nodeId: 'I:3', error: 'Node is unavailable' },
        { nodeId: 'S:1', error: 'Unable to read this node' },
      ],
    });
    expect(unreadable.getMainComponentAsync).not.toHaveBeenCalled();
  });

  it('rejects an explicit empty selection or unsupported editor instead of reporting a clean page', async () => {
    await expect(makeAudit([]).run('selection')).rejects.toThrow(/nothing selected/i);
    await expect(makeAudit([]).run('document')).rejects.toThrow(/scope must be/);
    await expect(makeAudit([], [], 'figjam').run()).rejects.toThrow(/Figma Design and Dev Mode/);
  });

  it('keeps a confirmed source and its instance when library variants cannot be enumerated', async () => {
    const set = makeSet('S:1', [{ name: 'Size=M' }], { remote: true });
    const instance = makeInstance('I:1', set.children[0]!);
    Object.defineProperty(set, 'children', {
      get() {
        throw new Error('in get_children: Library variants are unavailable');
      },
    });
    const result = await makeAudit([instance], [instance]).run();
    expect(result).toMatchObject({
      componentSets: [
        { nodeId: 'S:1', affectedInstances: [{ nodeId: 'I:1' }], variantFindings: [] },
      ],
      unreadableNodes: [{ nodeId: 'S:1', error: 'Library variants are unavailable' }],
    });
  });
});
