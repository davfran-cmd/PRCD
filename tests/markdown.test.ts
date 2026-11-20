import { describe, expect, it } from 'vitest';
import { renderMarkdown, resolveReference, resolveRelativePath, splitFrontmatter } from '../src/documents/markdown';

describe('markdown rendering', () => {
  it('renders CommonMark + GFM: headings, lists, tables, blockquotes, task lists, strikethrough', () => {
    const { html } = renderMarkdown(`# Titolo\n\n- uno\n- due\n\n1. a\n2. b\n\n> citazione\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] fatto\n- [ ] da fare\n\n~~via~~ **forte** *enfasi* https://example.com`);
    expect(html).toContain('<h1 id="h-titolo">Titolo</h1>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<ol>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<table>');
    expect(html).toContain('<del>via</del>');
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
    expect(html).toContain('<strong>forte</strong>');
    expect(html).toContain('href="https://example.com"');
  });

  it('highlights fenced code blocks', () => {
    const { html } = renderMarkdown('```python\ndef f(x):\n    return x + 1\n```');
    expect(html).toContain('language-python');
    expect(html).toContain('hljs-keyword');
  });

  it('renders inline and display LaTeX with KaTeX (no network) and preserves the notation', () => {
    const { html } = renderMarkdown('Il flusso $\\Phi = \\int \\vec{B}\\cdot d\\vec{A}$ e\n\n$$\n\\oint_\\gamma \\vec{B}\\cdot d\\vec{l} = \\mu_0 I_{conc}\n$$\n');
    expect(html).toContain('class="katex"');
    expect(html).toContain('katex-display');
    expect(html).toContain('<annotation encoding="application/x-tex">\\oint_\\gamma');
    expect(html).toContain('\\mu_0 I_{conc}');
    expect(html).not.toContain('katex-error');
  });

  it('does not crash on invalid LaTeX: it shows the error inline', () => {
    const { html } = renderMarkdown('Rotto: $\\frac{1}{$ fine');
    expect(html).toContain('fine');
  });

  it('parses YAML frontmatter and keeps it out of the body', () => {
    const r = renderMarkdown('---\ntitle: Legge di Ampère\ntags: [lezione, fisica]\ndate: 2026-11-20\n---\n# Ampère\n');
    expect(r.frontmatter.title).toBe('Legge di Ampère');
    expect(r.frontmatter.tags).toEqual(['lezione', 'fisica']);
    expect(r.html).not.toContain('title: Legge');
    expect(r.html).toContain('Ampère</h1>');
    // malformed YAML must not hide the note
    expect(renderMarkdown('---\n: : bad\n  - [\n---\nCorpo').html).toContain('Corpo');
    expect(splitFrontmatter('niente frontmatter').data).toEqual({});
  });

  it('turns Obsidian wiki-links into internal-link anchors (alias and heading supported)', () => {
    const r = renderMarkdown('Vedi [[13 Forza di Lorentz]], [[Formulario|il formulario]] e [[Ampère#Applicazioni]].');
    expect(r.wikiLinks).toEqual([
      { target: '13 Forza di Lorentz', anchor: null },
      { target: 'Formulario', anchor: null },
      { target: 'Ampère', anchor: 'Applicazioni' },
    ]);
    expect(r.html).toContain('data-prcd-wiki="13 Forza di Lorentz"');
    expect(r.html).toContain('>il formulario</a>');
    expect(r.html).toContain('data-prcd-anchor="Applicazioni"');
    expect(r.html).toContain('href="#"');
  });

  it('does not touch wiki-link syntax inside code', () => {
    const r = renderMarkdown('`[[x]]`\n\n```\n[[y]]\n```\n');
    expect(r.wikiLinks).toHaveLength(0);
  });

  it('records images (relative and Obsidian embeds) without ever loading them', () => {
    const r = renderMarkdown('![filo](img/ampere-filo.png)\n\n![[schema.png]]\n\n![[grafico.png|300]]\n\n![remota](https://evil.example/x.png)');
    expect(r.images.map((i) => [i.src, i.embed])).toEqual([
      ['img/ampere-filo.png', false],
      ['schema.png', true],
      ['grafico.png', true],
      ['https://evil.example/x.png', false],
    ]);
    expect(r.html).not.toMatch(/\ssrc="[^"]+"/); // every src is empty: the viewer decides
    expect(r.html).toContain('data-prcd-src="img/ampere-filo.png"');
    expect(r.html).toContain('width="300"');
  });

  it('sanitises hostile input: scripts, event handlers, javascript: URLs, iframes, raw HTML', () => {
    const evil = [
      '<script>alert(1)</script>',
      '<img src=x onerror="alert(2)">',
      '<iframe src="https://evil.example"></iframe>',
      '<a href="javascript:alert(3)">click</a>',
      '[link](javascript:alert(4))',
      '[data](data:text/html;base64,PHNjcmlwdD4=)',
      '<style>body{display:none}</style>',
      '<div onclick="x()">hi</div>',
      '![x](javascript:alert(5))',
      '<svg onload="alert(6)"><circle/></svg>',
      '<form action="https://evil.example"><input name=p></form>',
    ].join('\n\n');
    const { html } = renderMarkdown(evil);
    for (const bad of ['<script', 'onerror', 'onclick', 'onload', '<iframe', 'javascript:', '<style', '<form', '<svg', 'data:text/html']) {
      expect(html.toLowerCase(), bad).not.toContain(bad);
    }
  });

  it('keeps external http links but never executable ones', () => {
    const { html } = renderMarkdown('[ok](https://example.com/a) [mail](mailto:a@b.it) [bad](vbscript:x)');
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('href="mailto:a@b.it"');
    expect(html).not.toContain('vbscript');
  });

  it('relative links to other documents become internal link targets', () => {
    const r = renderMarkdown('[Ampère](../Appunti/14%20Legge%20di%20Amp%C3%A8re.md#applicazioni)');
    expect(r.html).toContain('data-prcd-href="../Appunti/14%20Legge%20di%20Amp%C3%A8re.md#applicazioni"');
  });

  it('builds an outline with unique heading ids', () => {
    const r = renderMarkdown('# A\n\n## B\n\n## B\n\n### Più è meglio');
    expect(r.headings.map((h) => [h.level, h.id])).toEqual([[1, 'h-a'], [2, 'h-b'], [2, 'h-b-1'], [3, 'h-piu-e-meglio']]);
  });
});

describe('relative image and link paths', () => {
  const index = [
    { path: 'Fisica 2/Appunti/14 Legge di Ampère.md', id: 'n14' },
    { path: 'Fisica 2/Appunti/img/ampere-filo.png', id: 'img1' },
    { path: 'Fisica 2/allegati/schema.png', id: 'img2' },
    { path: 'Analisi 2/allegati/schema.png', id: 'img3' },
    { path: 'Fisica 2/Appunti/13 Forza di Lorentz.md', id: 'n13' },
    { path: 'Formulario.md', id: 'f' },
  ];
  const base = 'Fisica 2/Appunti/14 Legge di Ampère.md';

  it('resolves ./ and ../ segments and decodes percent-encoding', () => {
    expect(resolveRelativePath(base, 'img/ampere-filo.png')).toBe('Fisica 2/Appunti/img/ampere-filo.png');
    expect(resolveRelativePath(base, './img/ampere-filo.png')).toBe('Fisica 2/Appunti/img/ampere-filo.png');
    expect(resolveRelativePath(base, '../allegati/schema.png')).toBe('Fisica 2/allegati/schema.png');
    expect(resolveRelativePath(base, '13%20Forza%20di%20Lorentz.md')).toBe('Fisica 2/Appunti/13 Forza di Lorentz.md');
    expect(resolveRelativePath(base, '../../../../etc/passwd')).toBeNull(); // cannot escape the library
    expect(resolveRelativePath(base, 'https://example.com/x.png')).toBeNull();
  });

  it('finds relative images and falls back to Obsidian-style lookup by name, preferring the closest folder', () => {
    expect(resolveReference('img/ampere-filo.png', base, index)?.id).toBe('img1');
    expect(resolveReference('../allegati/schema.png', base, index)?.id).toBe('img2');
    expect(resolveReference('schema.png', base, index)?.id).toBe('img2'); // two candidates: same course wins
    expect(resolveReference('schema.png', 'Analisi 2/n.md', index)?.id).toBe('img3');
    expect(resolveReference('inesistente.png', base, index)).toBeNull();
  });

  it('resolves wiki-link names with or without the .md extension, case-insensitively', () => {
    expect(resolveReference('13 Forza di Lorentz', base, index, { markdown: true })?.id).toBe('n13');
    expect(resolveReference('formulario', base, index, { markdown: true })?.id).toBe('f');
    expect(resolveReference('FORMULARIO.md', base, index, { markdown: true })?.id).toBe('f');
  });
});
