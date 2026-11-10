import type { AuditComponentSetsResult } from '@figwright/shared';

import { TimeSlice } from '../cooperative.js';
import type { SandboxToolHandler } from '../dispatcher.js';
import { readComponentGetter } from '../serializer.js';
import { collectMatches } from '../traverse.js';
import { INSTANCE_COMPONENT_SET_REPAIR_HINT, isComponentSetError } from './component-property.js';

type SetReport = AuditComponentSetsResult['componentSets'][number];
type VariantFinding = SetReport['variantFindings'][number];

const identify = (node: SceneNode) => ({ nodeId: node.id, name: node.name });

const parentSet = (component: ComponentNode): ComponentSetNode | null => {
  const parent = component.parent;
  return parent?.type === 'COMPONENT_SET' ? parent : null;
};

// Figma documents the layer name as the source of variant assignments (Size=Small, State=Hover).
// Only use the fallback for a name we can parse completely, and label findings based on names.
const parseVariantName = (name: string): [string, string][] | null => {
  const props = new Map<string, string>();
  for (const assignment of name.split(',')) {
    const parts = assignment.split('=');
    const key = parts[0]?.trim();
    const value = parts[1]?.trim();
    if (parts.length !== 2 || !key || !value || props.has(key)) return null;
    props.set(key, value);
  }
  return [...props];
};

interface VariantEvidence {
  variant: ReturnType<typeof identify>;
  axes: string;
  values: string;
  source: VariantFinding['source'];
}

const variantEvidence = (node: ComponentNode): VariantEvidence | null => {
  const read = readComponentGetter(() => node.variantProperties);
  const properties = 'value' in read ? read.value : null;
  const entries = properties === null ? parseVariantName(node.name) : Object.entries(properties);
  if (entries === null || entries.length === 0) return null;
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    variant: identify(node),
    axes: JSON.stringify(entries.map(([key]) => key)),
    values: JSON.stringify(entries),
    source: properties === null ? 'variant_names' : 'variant_properties',
  };
};

const finding = (
  kind: VariantFinding['kind'],
  group: readonly VariantEvidence[],
): VariantFinding => ({
  kind,
  source: group.some(item => item.source === 'variant_names')
    ? 'variant_names'
    : 'variant_properties',
  variants: group.map(item => item.variant),
});

const inspectVariants = (set: ComponentSetNode): VariantFinding[] => {
  const evidence: VariantEvidence[] = [];
  const combinations = new Map<string, VariantEvidence[]>();
  for (const child of set.children) {
    if (child.type !== 'COMPONENT') continue;
    const item = variantEvidence(child);
    if (item === null) continue;
    evidence.push(item);
    const group = combinations.get(item.values);
    if (group === undefined) combinations.set(item.values, [item]);
    else group.push(item);
  }

  const findings: VariantFinding[] = [];
  for (const group of combinations.values()) {
    if (group.length > 1) findings.push(finding('duplicate_variant_values', group));
  }
  if (new Set(evidence.map(item => item.axes)).size > 1) {
    findings.push(finding('inconsistent_variant_properties', evidence));
  }
  return findings;
};

const describeSet = (
  set: ComponentSetNode,
  error: string,
  variantFindings: VariantFinding[],
): SetReport => {
  const repairHints = [
    set.remote
      ? 'Open the component set in its source library. After fixing it, publish the library and apply the update in the consuming file.'
      : 'Open the component set in Figma Design and check its variants in the Properties panel.',
  ];
  if (
    variantFindings.length === 0 ||
    variantFindings.some(f => f.kind === 'duplicate_variant_values')
  ) {
    repairHints.push('Give every variant a unique combination of property values.');
  }
  if (
    variantFindings.length === 0 ||
    variantFindings.some(f => f.kind === 'inconsistent_variant_properties')
  ) {
    repairHints.push(
      'Use the same property names on every variant and check for mistyped variant names.',
    );
  }
  return {
    ...identify(set),
    remote: set.remote,
    error,
    affectedInstances: [],
    variantFindings,
    repairHints,
  };
};

const resolveInstanceSet = async (
  instance: InstanceNode,
): Promise<{ set: ComponentSetNode } | { reason: string }> => {
  try {
    const main = await instance.getMainComponentAsync();
    if (main === null) return { reason: 'Figma did not return a main component.' };
    const set = parentSet(main);
    return set === null
      ? { reason: 'The main component has no accessible component set.' }
      : { set };
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }
};

// Avoid a lookup for healthy instances, and bound the number of concurrent native lookups on a
// page with many affected instances. Process each batch in scan order regardless of resolve order.
const INSTANCE_LOOKUP_BATCH_SIZE = 16;

export const createAuditComponentSetsHandler =
  (figmaCtx: typeof figma): SandboxToolHandler =>
  async params => {
    if (figmaCtx.editorType !== 'figma' && figmaCtx.editorType !== 'dev') {
      throw new Error(
        'audit_component_sets: component sets are available in Figma Design and Dev Mode.',
      );
    }
    const requested = ((params ?? {}) as { scope?: unknown }).scope;
    if (requested !== undefined && requested !== 'selection' && requested !== 'current_page') {
      throw new TypeError('audit_component_sets: scope must be selection or current_page.');
    }
    const page = figmaCtx.currentPage;
    const selection = page.selection;
    const scope = requested ?? (selection.length > 0 ? 'selection' : 'current_page');
    if (scope === 'selection' && selection.length === 0) {
      throw new Error('audit_component_sets: nothing selected. Select layers or use current_page.');
    }
    const result: AuditComponentSetsResult = {
      scope,
      pageId: page.id,
      skipsInvisibleInstanceChildren: figmaCtx.skipInvisibleInstanceChildren,
      componentSets: [],
      unresolvedInstances: [],
      unreadableNodes: [],
    };
    const nodes = await collectMatches(
      scope === 'selection' ? selection : page.children,
      node =>
        node.type === 'COMPONENT_SET' || node.type === 'COMPONENT' || node.type === 'INSTANCE',
    );
    const seenNodes = new Set<string>();
    const checkedSets = new Set<string>();
    const reports = new Map<string, SetReport>();
    const failures: { node: InstanceNode; identity: ReturnType<typeof identify>; error: string }[] =
      [];
    const slice = new TimeSlice();

    const reportSet = (set: ComponentSetNode, error: string): SetReport => {
      const existing = reports.get(set.id);
      if (existing !== undefined) return existing;
      const variants = readComponentGetter(() => inspectVariants(set));
      if ('error' in variants) {
        result.unreadableNodes.push({ ...identify(set), error: variants.error });
      }
      const report = describeSet(set, error, 'value' in variants ? variants.value : []);
      reports.set(set.id, report);
      return report;
    };

    for (const node of nodes) {
      if (node.removed || seenNodes.has(node.id)) continue;
      seenNodes.add(node.id);
      if (node.type === 'INSTANCE') {
        const read = readComponentGetter(() => node.componentProperties);
        if ('error' in read) {
          if (isComponentSetError(read.error)) {
            failures.push({ node, identity: identify(node), error: read.error });
          } else result.unreadableNodes.push({ ...identify(node), error: read.error });
        }
      } else {
        const set =
          node.type === 'COMPONENT_SET' ? node : node.type === 'COMPONENT' ? parentSet(node) : null;
        if (set !== null && !checkedSets.has(set.id)) {
          checkedSets.add(set.id);
          const read = readComponentGetter(() => set.variantGroupProperties);
          if ('error' in read) {
            if (isComponentSetError(read.error)) reportSet(set, read.error);
            else result.unreadableNodes.push({ ...identify(set), error: read.error });
          }
        }
      }
      // eslint-disable-next-line no-await-in-loop -- hand the thread back between slices of native reads
      if (slice.due()) await slice.yield();
    }

    for (let offset = 0; offset < failures.length; offset += INSTANCE_LOOKUP_BATCH_SIZE) {
      const batch = failures.slice(offset, offset + INSTANCE_LOOKUP_BATCH_SIZE);
      // eslint-disable-next-line no-await-in-loop -- bound concurrent native lookups
      const resolved = await Promise.all(batch.map(({ node }) => resolveInstanceSet(node)));
      for (const [index, resolution] of resolved.entries()) {
        const { identity, error } = batch[index]!;
        if ('set' in resolution) {
          reportSet(resolution.set, error).affectedInstances.push(identity);
        } else {
          result.unresolvedInstances.push({
            ...identity,
            error,
            reason: resolution.reason,
            repairHint: INSTANCE_COMPONENT_SET_REPAIR_HINT,
          });
        }
      }
      // eslint-disable-next-line no-await-in-loop -- yield while building reports for large scans
      if (slice.due()) await slice.yield();
    }
    result.componentSets = [...reports.values()];
    return result;
  };
