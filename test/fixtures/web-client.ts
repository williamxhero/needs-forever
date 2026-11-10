import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';

// Deliberately small DOM at the browser boundary. The served script, HTTP
// requests, rendered markup, wiring and refresh are real; no app code is mocked.
class Element {
  private markup = '';
  className = '';
  textContent = '';
  hidden = false;
  title = '';
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: Element[] = [];
  onclick: ((event: { preventDefault(): void; stopPropagation(): void }) => unknown) | null = null;
  readonly classList = {
    contains: (value: string) => this.className.split(/\s+/).includes(value),
    toggle: (value: string, force?: boolean): boolean => {
      const classes = new Set(this.className.split(/\s+/).filter(Boolean));
      const next = force ?? !classes.has(value);
      if (next) classes.add(value); else classes.delete(value);
      this.className = [...classes].join(' ');
      return next;
    },
    add: (value: string) => { this.classList.toggle(value, true); },
    remove: (value: string) => { this.classList.toggle(value, false); },
  };
  set innerHTML(value: string) {
    this.markup = value;
    this.children = [];
    // The UI's interactive elements contain spans, but never nested buttons.
    for (const match of value.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
      const node = new Element();
      for (const attribute of match[1]!.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
        node.setAttribute(attribute[1]!, decode(attribute[2] ?? ''));
      }
      node.markup = match[2]!;
      node.textContent = decode(match[2]!.replace(/<[^>]*>/g, ''));
      if (match[2]!.includes('collapse-marker')) {
        const marker = new Element(); marker.className = 'collapse-marker'; marker.textContent = '⌄';
        node.children.push(marker);
      }
      this.children.push(node);
    }
  }
  get innerHTML(): string { return this.markup; }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
    if (name === 'class') this.className = value;
    if (name === 'title') this.title = value;
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
  }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap((node) => [node, ...node.querySelectorAll('*')]).filter((node) => matches(node, selector));
  }
  click(): void { this.onclick?.({ preventDefault() {}, stopPropagation() {} }); }
}

function decode(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#39);/g, (part) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[part]!));
}

function matches(node: Element, selector: string): boolean {
  if (selector === '*') return true;
  if (selector.startsWith('.')) return node.classList.contains(selector.slice(1));
  const attribute = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\](?:\.(\w+))?$/);
  return Boolean(attribute && node.getAttribute(attribute[1]!) !== null
    && (attribute[2] === undefined || node.getAttribute(attribute[1]!) === attribute[2])
    && (!attribute[3] || node.classList.contains(attribute[3])));
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'served browser script did not settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function openWebClient(url: string) {
  const page = await (await fetch(url)).text();
  const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'served page includes its actual inline client script');
  const roots = new Map<string, Element>();
  for (const id of page.matchAll(/\bid="([^"]+)"/g)) roots.set(id[1]!, new Element());
  const document = {
    querySelector: (selector: string): Element | null => selector.startsWith('#') ? roots.get(selector.slice(1)) ?? null : document.querySelectorAll(selector)[0] ?? null,
    querySelectorAll: (selector: string): Element[] => [...roots.values()].flatMap((root) => root.querySelectorAll(selector)),
  };
  const intervals: (() => void)[] = [];
  const copied: string[] = [];
  const context = createContext({
    document, location: { href: url }, URL, console,
    history: { pushState() {}, replaceState() {} },
    window: { confirm: () => false }, navigator: { clipboard: { writeText: async (text: string) => { copied.push(text); } } },
    fetch: (input: string, init?: RequestInit) => fetch(new URL(input, url), init),
    setInterval: (callback: () => void) => { intervals.push(callback); }, setTimeout: () => 0,
  });
  runInContext(script, context, { filename: 'served-nfg-client.js' });
  await waitFor(() => Boolean(document.querySelector('#timeline')?.innerHTML.includes('WORKER 发出')) || Boolean(document.querySelector('#error')?.textContent));
  assert.equal(document.querySelector('#error')!.textContent, '', 'initial HTTP/rendering load succeeded');
  return {
    document, copied,
    async refresh() {
      intervals[0]!();
      await waitFor(() => runInContext('app.refreshing', context) === false);
      assert.equal(document.querySelector('#error')!.textContent, '', 'asynchronous HTTP refresh succeeded');
    },
  };
}
