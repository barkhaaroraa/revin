/**
 * The URN graph resolver.
 *
 * Voyager's `application/vnd.linkedin.normalized+json+2.1` representation is a
 * FLAT graph, not a nested document:
 *
 *   {
 *     "data":     { "*elements": ["urn:li:fsd_profilePosition:(...,123)"] },
 *     "included": [ { "entityUrn": "urn:li:fsd_profilePosition:(...,123)",
 *                     "$type": "com.linkedin.voyager.dash.identity.profile.Position",
 *                     "title": "Software Engineer" } ]
 *   }
 *
 * Everything lives in `included[]`, and the tree points at it by URN string.
 * Keys prefixed with `*` hold references rather than values. So reading it is
 * a two-step: index `included[]` by `entityUrn`, then walk from the root
 * resolving every reference through that index.
 *
 * This is the same idea as a normalizr store or Apollo's cache. The graph
 * contains cycles (a Position references a Company which references Positions),
 * so every traversal carries a `seen` set.
 *
 * One design choice worth calling out: responses from SEVERAL endpoints are
 * merged into ONE graph. A profile fetch makes ~14 calls whose `included[]`
 * arrays overlap heavily — the same Company appears in the positions response
 * and the education response. Merging means an entity is resolvable no matter
 * which call happened to carry it.
 */

export interface NormalizedResponse {
  data?: unknown;
  included?: unknown[];
}

export type Entity = Record<string, unknown>;

/** True for the reference keys Voyager marks with a leading asterisk. */
export function isReferenceKey(key: string): boolean {
  return key.startsWith('*');
}

/** The field name a `*`-prefixed reference key corresponds to. */
export function referenceName(key: string): string {
  return key.slice(1);
}

export class EntityGraph {
  private readonly index = new Map<string, Entity>();

  constructor(responses: Array<unknown> = []) {
    for (const r of responses) this.add(r);
  }

  /** Index one response's `included[]` into the graph. */
  add(response: unknown): this {
    const included = (response as NormalizedResponse | null)?.included;
    if (!Array.isArray(included)) return this;
    for (const raw of included) {
      if (typeof raw !== 'object' || raw === null) continue;
      const entity = raw as Entity;
      const urn = entity['entityUrn'];
      if (typeof urn === 'string') {
        // Later responses win. They are generally richer projections, and a
        // sparse duplicate overwriting a full one would silently lose fields.
        const existing = this.index.get(urn);
        this.index.set(urn, existing ? { ...existing, ...entity } : entity);
      }
    }
    return this;
  }

  get(urn: string | undefined | null): Entity | undefined {
    return typeof urn === 'string' ? this.index.get(urn) : undefined;
  }

  /**
   * Every entity whose `$type` ends with the given suffix.
   *
   * Matching on the suffix rather than the full type string is deliberate:
   * LinkedIn's fully-qualified names carry package paths that shift between
   * API versions, while the leaf name (`profile.Position`) is stable.
   */
  ofType(typeSuffix: string): Entity[] {
    const out: Entity[] = [];
    for (const entity of this.index.values()) {
      if (String(entity['$type'] ?? '').endsWith(typeSuffix)) out.push(entity);
    }
    return out;
  }

  /**
   * Resolve a collection response's ordered elements.
   *
   * Rest.li collections put the ORDER in `data['*elements']` and the content in
   * `included[]`. The included array is not ordered meaningfully, so reading it
   * directly would scramble a work history that is supposed to be reverse
   * chronological. Always resolve through `*elements`.
   */
  elements(response: unknown): Entity[] {
    const data = (response as NormalizedResponse | null)?.data as Entity | undefined;
    if (!data) return [];
    const refs = data['*elements'] ?? data['elements'];
    if (!Array.isArray(refs)) return [];
    const out: Entity[] = [];
    for (const ref of refs) {
      if (typeof ref === 'string') {
        const entity = this.get(ref);
        if (entity) out.push(entity);
      } else if (typeof ref === 'object' && ref !== null) {
        // Some projections inline the element instead of referencing it.
        out.push(ref as Entity);
      }
    }
    return out;
  }

  /**
   * Follow one reference field on an entity, accepting either spelling.
   *
   * A field may arrive as `*geo: "urn:..."` (a reference) or as `geo: {...}`
   * (inlined), depending on the projection. Callers should not have to care.
   */
  follow(entity: Entity | undefined, field: string): Entity | undefined {
    if (!entity) return undefined;
    const ref = entity[`*${field}`];
    if (typeof ref === 'string') return this.get(ref);
    const inline = entity[field];
    if (typeof inline === 'string') return this.get(inline);
    if (typeof inline === 'object' && inline !== null) return inline as Entity;
    return undefined;
  }

  get size(): number {
    return this.index.size;
  }
}
