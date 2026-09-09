// STORY-036 — the automaton.
//
// `tracking-engine.md` Stage 2: "An Aho-Corasick automaton built once per
// project from `brand_aliases ∪ competitor aliases ∪ discovered-candidate
// labels`... **O(n) in response length regardless of alias count**."
//
// LINEAR IN THE RESPONSE, NOT IN THE ALIAS COUNT, and that is the reason for
// an automaton rather than a loop over `indexOf`. A project with 200 aliases
// scanning a 4000-character answer is 800,000 character comparisons the naive
// way, per cell, per engine, per run. Aho-Corasick walks the text ONCE and
// the alias count only affects how long the automaton took to build — which
// is why it is built per project and cached, not per capture.

/** A pattern the automaton was built from, and whatever the caller attached to it. */
export interface Pattern<T> {
  /** Already folded by the caller. The automaton does no folding of its own. */
  readonly text: string;
  readonly value: T;
}

export interface Match<T> {
  /** Half-open, into the string that was scanned. */
  readonly start: number;
  readonly end: number;
  readonly pattern: Pattern<T>;
}

interface Node<T> {
  readonly next: Map<string, number>;
  /** Longest proper suffix of this node's string that is also a node. */
  fail: number;
  /** Patterns ending here, plus everything reachable through the fail chain. */
  readonly outputs: Pattern<T>[];
}

export class AhoCorasick<T> {
  private readonly nodes: Node<T>[] = [{ next: new Map(), fail: 0, outputs: [] }];

  constructor(patterns: readonly Pattern<T>[]) {
    for (const pattern of patterns) this.insert(pattern);
    this.link();
  }

  /** How many states the automaton has — for the cache-size assertions. */
  get size(): number {
    return this.nodes.length;
  }

  private insert(pattern: Pattern<T>): void {
    // An empty pattern would match at every position and terminate nothing.
    // Silently ignored rather than thrown: an empty alias is a data problem
    // in one project's configuration, and refusing to build the automaton
    // would take down matching for every capture in that project.
    if (pattern.text.length === 0) return;

    let node = 0;
    for (const character of pattern.text) {
      let next = this.nodes[node]!.next.get(character);
      if (next === undefined) {
        next = this.nodes.length;
        this.nodes.push({ next: new Map(), fail: 0, outputs: [] });
        this.nodes[node]!.next.set(character, next);
      }
      node = next;
    }
    this.nodes[node]!.outputs.push(pattern);
  }

  /**
   * Breadth-first failure links, with outputs inherited along them.
   *
   * Inheriting at BUILD time rather than walking the fail chain at match time
   * is what keeps matching linear: without it, a text of `n` characters
   * against deeply-nested patterns walks the chain repeatedly and the bound
   * degrades. The cost is paid once per automaton, which is once per project.
   */
  private link(): void {
    const queue: number[] = [];
    for (const child of this.nodes[0]!.next.values()) {
      this.nodes[child]!.fail = 0;
      queue.push(child);
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const [character, child] of this.nodes[current]!.next) {
        let fail = this.nodes[current]!.fail;
        while (fail !== 0 && !this.nodes[fail]!.next.has(character)) {
          fail = this.nodes[fail]!.fail;
        }
        const target = this.nodes[fail]!.next.get(character);
        this.nodes[child]!.fail = target !== undefined && target !== child ? target : 0;
        this.nodes[child]!.outputs.push(...this.nodes[this.nodes[child]!.fail]!.outputs);
        queue.push(child);
      }
    }
  }

  /**
   * Every match, in the order their ENDS occur.
   *
   * Overlapping and nested matches are all reported — "Sales" inside
   * "Salesforce" comes back alongside it. Deciding which one survives is the
   * caller's job, because the rule ("the longer name wins") is a domain rule
   * about entities and not a property of string matching.
   */
  *matches(text: string): Generator<Match<T>> {
    let node = 0;
    let index = 0;

    for (const character of text) {
      while (node !== 0 && !this.nodes[node]!.next.has(character)) {
        node = this.nodes[node]!.fail;
      }
      node = this.nodes[node]!.next.get(character) ?? 0;
      index += character.length;

      for (const pattern of this.nodes[node]!.outputs) {
        yield { start: index - pattern.text.length, end: index, pattern };
      }
    }
  }
}
