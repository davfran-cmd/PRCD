/**
 * Tiny tree walker (a subset of unist-util-visit) so we do not depend on a transitive package.
 * The visitor may return a number to continue at that child index after replacing nodes.
 */
interface UnistNode {
  type: string;
  children?: UnistNode[];
}

export function visit<T extends UnistNode>(
  tree: UnistNode,
  type: string,
  visitor: (node: T, index: number | null, parent: UnistNode | null) => number | void,
): void {
  const walk = (node: UnistNode, index: number | null, parent: UnistNode | null) => {
    if (node.type === type) {
      const next = visitor(node as T, index, parent);
      if (typeof next === 'number' && parent) return next;
    }
    const children = node.children;
    if (children) {
      for (let i = 0; i < children.length; ) {
        const r = walk(children[i], i, node);
        i = typeof r === 'number' ? r : i + 1;
      }
    }
    return undefined;
  };
  walk(tree, null, null);
}
