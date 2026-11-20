/**
 * Markdown → sanitized HTML.
 *
 * Supported: CommonMark + GFM (tables, task lists, strikethrough, autolinks), YAML frontmatter,
 * fenced code with syntax highlighting, inline/display LaTeX (KaTeX), Obsidian wiki-links
 * ([[Note]], [[Note|alias]], [[Note#Heading]]) and image embeds (![[img.png|300]]).
 *
 * Security: document content is untrusted. Raw HTML is dropped, the tree is sanitized with an
 * allow-list schema *before* KaTeX/highlighting add their (trusted, generated) markup, remote and
 * local image sources are never put in `src` here (the viewer resolves local ones to blob URLs and
 * does not auto-load remote ones), and links are rewritten to data attributes handled by the viewer.
 */
import { unified, type Plugin } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeSanitize, { defaultSchema, type Options as SanitizeOptions } from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import rehypeStringify from 'rehype-stringify';
import { parse as parseYaml } from 'yaml';
import type { Element, Root as HastRoot, ElementContent } from 'hast';
import type { Root as MdastRoot, Text, PhrasingContent } from 'mdast';
import { visit } from './visit';

export interface RenderedMarkdown {
  html: string;
  frontmatter: Record<string, unknown>;
  headings: Array<{ level: number; text: string; id: string }>;
  /** Image references found in the note: where the viewer must look. */
  images: Array<{ src: string; embed: boolean }>;
  wikiLinks: Array<{ target: string; anchor: string | null }>;
}

const FRONTMATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

export function splitFrontmatter(src: string): { data: Record<string, unknown>; body: string } {
  const m = FRONTMATTER.exec(src);
  if (!m) return { data: {}, body: src };
  try {
    const parsed = parseYaml(m[1]);
    const data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    return { data, body: src.slice(m[0].length) };
  } catch {
    // Malformed YAML must not hide the note: show the whole text.
    return { data: {}, body: src.slice(m[0].length) };
  }
}

const WIKI = /(!?)\[\[([^\[\]|#\n]+?)(#[^\[\]|\n]*)?(?:\|([^\[\]\n]*))?\]\]/g;

/** Turns Obsidian `[[…]]` / `![[…]]` inside plain text nodes into link/image nodes. Code and math are untouched. */
const remarkObsidian: Plugin<[], MdastRoot> = () => (tree) => {
  visit(tree as never, 'text', ((node: Text, index: number | null, parent: { children: PhrasingContent[] } | null) => {
    if (!parent || index === null || !node.value.includes('[[')) return;
    const out: PhrasingContent[] = [];
    let last = 0;
    WIKI.lastIndex = 0;
    for (let m = WIKI.exec(node.value); m; m = WIKI.exec(node.value)) {
      if (m.index > last) out.push({ type: 'text', value: node.value.slice(last, m.index) });
      const embed = m[1] === '!';
      const target = m[2].trim();
      const anchor = m[3] ? m[3].slice(1).trim() : null;
      const alias = m[4]?.trim();
      if (embed) {
        const isSize = alias !== undefined && /^\d+(x\d+)?$/.test(alias);
        out.push({
          type: 'image',
          url: '',
          alt: !isSize && alias ? alias : target,
          data: { hProperties: { dataPrcdSrc: target, dataPrcdEmbed: '1', ...(isSize ? { width: alias.split('x')[0] } : {}) } },
        } as PhrasingContent);
      } else {
        out.push({
          type: 'link',
          url: '#',
          children: [{ type: 'text', value: alias || (anchor ? `${target} > ${anchor}` : target) }],
          data: { hProperties: { dataPrcdWiki: target, ...(anchor ? { dataPrcdAnchor: anchor } : {}) } },
        } as PhrasingContent);
      }
      last = m.index + m[0].length;
    }
    if (!out.length) return;
    if (last < node.value.length) out.push({ type: 'text', value: node.value.slice(last) });
    parent.children.splice(index, 1, ...out);
    return index + out.length;
  }) as never);
};

const isWebUrl = (u: string) => /^(https?:|mailto:|tel:)/i.test(u);
const hasScheme = (u: string) => /^[a-z][a-z0-9+.-]*:/i.test(u.trim());
/** Targets we are willing to carry in a data attribute: relative paths, web URLs, and small raster data URIs. */
const isSafeTarget = (u: string, image: boolean) => !hasScheme(u) || isWebUrl(u) || (image && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(u.trim()));

/** Moves every image/link target into data attributes so nothing loads or navigates by itself. */
function rehypeRewriteTargets(refs: { images: RenderedMarkdown['images']; links: RenderedMarkdown['wikiLinks'] }): Plugin<[], HastRoot> {
  return () => (tree) => {
    visit(tree as never, 'element', (node: Element) => {
      const p = node.properties ?? (node.properties = {});
      if (node.tagName === 'img') {
        const embed = p.dataPrcdEmbed === '1';
        const src = String(p.dataPrcdSrc ?? p.src ?? '');
        p.src = '';
        if (!isSafeTarget(src, true)) {
          p.dataPrcdSrc = '';
          p.dataPrcdBlocked = '1';
          return;
        }
        p.dataPrcdSrc = src;
        refs.images.push({ src, embed });
      } else if (node.tagName === 'a') {
        if (p.dataPrcdWiki) {
          refs.links.push({ target: String(p.dataPrcdWiki), anchor: p.dataPrcdAnchor ? String(p.dataPrcdAnchor) : null });
          p.href = '#';
          return;
        }
        const href = String(p.href ?? '');
        if (href.startsWith('#')) return; // in-page anchor
        if (!isWebUrl(href)) {
          if (hasScheme(href)) {
            // javascript:, data:, vbscript:, file:… never survive, not even as inert text.
            delete p.href;
            return;
          }
          p.dataPrcdHref = href;
          p.href = '#';
        }
      }
    });
  };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');

function textOf(node: ElementContent): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'element') return node.children.map(textOf).join('');
  return '';
}

function rehypeHeadingIds(out: RenderedMarkdown['headings']): Plugin<[], HastRoot> {
  return () => (tree) => {
    const seen = new Map<string, number>();
    visit(tree as never, 'element', (node: Element) => {
      const m = /^h([1-6])$/.exec(node.tagName);
      if (!m) return;
      const text = node.children.map(textOf).join('').trim();
      let id = `h-${slug(text) || 'sezione'}`;
      const n = seen.get(id) ?? 0;
      seen.set(id, n + 1);
      if (n) id = `${id}-${n}`;
      (node.properties ??= {}).id = id;
      out.push({ level: Number(m[1]), text, id });
    });
  };
}

export const SANITIZE_SCHEMA: SanitizeOptions = {
  ...defaultSchema,
  clobberPrefix: '',
  protocols: { ...defaultSchema.protocols, href: ['http', 'https', 'mailto', 'tel'], src: [] },
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.a ?? []), 'dataPrcdWiki', 'dataPrcdAnchor', 'dataPrcdHref'],
    img: ['alt', 'title', 'width', 'height', 'src', 'dataPrcdSrc', 'dataPrcdEmbed', 'dataPrcdBlocked'],
    // math + fenced code classes produced by remark-math / remark-rehype (language-*), nothing else
    code: [['className', /^(language-[\w+#-]+|math-inline|math-display)$/]],
    span: [['className', /^math(-inline|-display)?$/]],
    div: [['className', /^math(-inline|-display)?$/]],
    pre: [],
    input: [['type', 'checkbox'], ['checked', true], ['disabled', true]],
    th: ['align'],
    td: ['align'],
  },
  tagNames: [...(defaultSchema.tagNames ?? []), 'input'].filter((t) => !['iframe', 'script', 'style', 'object', 'embed', 'form', 'button', 'textarea', 'select', 'link', 'meta'].includes(t)),
  strip: ['script', 'style'],
};

export function renderMarkdown(source: string): RenderedMarkdown {
  const { data, body } = splitFrontmatter(source);
  const refs = { images: [] as RenderedMarkdown['images'], links: [] as RenderedMarkdown['wikiLinks'] };
  const headings: RenderedMarkdown['headings'] = [];
  const file = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkObsidian)
    .use(remarkRehype, { allowDangerousHtml: false })
    .use(rehypeRewriteTargets(refs))
    .use(rehypeSanitize, SANITIZE_SCHEMA)
    .use(rehypeHeadingIds(headings))
    .use(rehypeKatex, { throwOnError: false, strict: 'ignore', trust: false, output: 'htmlAndMathml', errorColor: '#B23A0A' } as never)
    .use(rehypeHighlight, { detect: false, ignoreMissing: true })
    .use(rehypeStringify)
    .processSync(body);
  return { html: String(file), frontmatter: data, headings, images: refs.images, wikiLinks: refs.links };
}

// ------------------------------------------------------------------ path resolution (images, links, wiki-links)

/** Resolve `rel` against the directory of `basePath` ("a/b/note.md" + "../img/x.png" → "a/img/x.png"). */
export function resolveRelativePath(basePath: string, rel: string): string | null {
  let target = rel.split('#')[0].split('?')[0];
  try {
    target = decodeURIComponent(target);
  } catch {
    /* keep raw */
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  const parts = target.startsWith('/') ? [] : basePath.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null; // escapes the library root
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

export interface PathEntry {
  path: string;
  id: string;
}

/**
 * Where a reference points. Relative paths are resolved against the note's folder; bare names
 * (Obsidian style, `![[x.png]]`, `[[Note]]`) are looked up anywhere in the library, preferring the
 * closest folder, then the shortest path — like Obsidian does.
 */
export function resolveReference(ref: string, fromPath: string, index: PathEntry[], opts: { markdown?: boolean } = {}): PathEntry | null {
  const lower = new Map(index.map((e) => [e.path.toLowerCase(), e]));
  const tryPath = (p: string | null): PathEntry | null => {
    if (!p) return null;
    const hit = lower.get(p.toLowerCase());
    if (hit) return hit;
    if (opts.markdown) return lower.get(`${p}.md`.toLowerCase()) ?? null;
    return null;
  };
  const rel = tryPath(resolveRelativePath(fromPath, ref));
  if (rel) return rel;
  // vault-root relative
  const root = tryPath(resolveRelativePath('', ref));
  if (root) return root;
  // by base name anywhere
  const name = decodeURIComponent(ref.split('#')[0]).split('/').pop()?.toLowerCase() ?? '';
  if (!name) return null;
  const names = opts.markdown && !/\.[a-z0-9]+$/.test(name) ? [name, `${name}.md`, `${name}.markdown`] : [name];
  const candidates = index.filter((e) => names.includes(e.path.split('/').pop()!.toLowerCase()));
  if (!candidates.length) return null;
  const fromDir = fromPath.split('/').slice(0, -1);
  const score = (e: PathEntry) => {
    const dir = e.path.split('/').slice(0, -1);
    let common = 0;
    while (common < dir.length && common < fromDir.length && dir[common] === fromDir[common]) common++;
    return [-common, e.path.length] as const;
  };
  return [...candidates].sort((a, b) => {
    const [ac, al] = score(a);
    const [bc, bl] = score(b);
    return ac - bc || al - bl;
  })[0];
}
