import { describe, expect, it } from 'vitest';
import { DocsRepo, isIgnoredPath, kindOf, type ImportEntry } from '../src/documents/docsRepo';
import { MemoryFileStore } from '../src/storage/fileStore';
import { makeRepo, seedDesign } from './helpers';
import { createArchive, restoreArchive } from '../src/db/backup';

const bytes = (s: string) => new TextEncoder().encode(s);
const entry = (path: string, content = path): ImportEntry => ({ path, data: bytes(content) });

async function setup() {
  const ctx = await seedDesign();
  const files = new MemoryFileStore();
  return { ...ctx, files, docs: new DocsRepo(ctx.repo, files) };
}

describe('document library', () => {
  it('imports a folder tree preserving the hierarchy, and never modifies the source bytes', async () => {
    const { docs, files } = await setup();
    const src = '# Ampère\n\n$B$';
    const report = await docs.importTree(
      [entry('Appunti/14 Legge di Ampère.md', src), entry('Appunti/img/ampere-filo.png', 'PNGDATA'), entry('Slide/magnetostatica.pdf', '%PDF-1.4 x'), entry('Formulario.md', '# F')],
      { parentFolderId: null, rootName: 'Fisica 2' },
    );
    expect(report.added).toBe(4);
    expect(report.errors).toEqual([]);
    const index = docs.pathIndex().map((e) => e.path).sort();
    expect(index).toEqual(['Fisica 2/Appunti/14 Legge di Ampère.md', 'Fisica 2/Appunti/img/ampere-filo.png', 'Fisica 2/Formulario.md', 'Fisica 2/Slide/magnetostatica.pdf']);
    const note = docs.documents().find((d) => d.fileName.startsWith('14'))!;
    expect(await docs.getText(note.id)).toBe(src); // byte for byte
    expect(note.kind).toBe('markdown');
    expect(docs.document(note.id)!.storageKey).toMatch(/^f\//);
    expect(await files.has(note.storageKey)).toBe(true);
    expect(docs.folderPath(note.folderId).map((f) => f.name)).toEqual(['Fisica 2', 'Appunti']);
  });

  it('skips hidden/system files and unsupported types, reporting why', async () => {
    const { docs } = await setup();
    const r = await docs.importTree([entry('vault/.obsidian/app.json'), entry('vault/.DS_Store'), entry('vault/nota.md'), entry('vault/archivio.zip'), entry('__MACOSX/x.md')], { parentFolderId: null });
    expect(r.added).toBe(1);
    expect(r.skipped.map((s) => s.path).sort()).toEqual(['__MACOSX/x.md', 'vault/.DS_Store', 'vault/.obsidian/app.json', 'vault/archivio.zip']);
    expect(isIgnoredPath('a/.git/config')).toBe(true);
    expect(isIgnoredPath('a/b.md')).toBe(false);
    expect(kindOf('x.PDF')).toBe('pdf');
    expect(kindOf('x.JPG')).toBe('image');
  });

  it('never overwrites: a name collision gets a suffix and both files survive', async () => {
    const { docs } = await setup();
    const a = await docs.addDocument({ data: bytes('uno'), fileName: 'Nota.md', folderId: null });
    const b = await docs.addDocument({ data: bytes('due'), fileName: 'Nota.md', folderId: null });
    expect(b.fileName).toBe('Nota (2).md');
    expect(await docs.getText(a.id)).toBe('uno');
    expect(await docs.getText(b.id)).toBe('due');
    const again = await docs.importTree([entry('Nota.md', 'tre')], { parentFolderId: null });
    expect(again.renamed).toEqual([{ from: 'Nota.md', to: 'Nota (3).md' }]);
  });

  it('renames (keeping the extension), moves, favourites, tags and links a document to a course', async () => {
    const { docs, repo, fisica } = await setup();
    const f = docs.createFolder('Appunti', null);
    const d = await docs.addDocument({ data: bytes('x'), fileName: 'a.md', folderId: null });
    docs.rename(d.id, 'Lezione 14');
    expect(docs.document(d.id)).toMatchObject({ name: 'Lezione 14', fileName: 'Lezione 14.md', kind: 'markdown' });
    docs.move(d.id, f.id);
    docs.setFavorite(d.id, true);
    docs.setTags(d.id, ['#esame', '#esame', ' #lezione ']);
    docs.setCourse(d.id, fisica.id);
    expect(docs.document(d.id)).toMatchObject({ folderId: f.id, favorite: true, tags: ['#esame', '#lezione'], courseId: fisica.id });
    expect(docs.documents({ favorite: true })).toHaveLength(1);
    expect(docs.documents({ tag: '#esame' })).toHaveLength(1);
    expect(docs.documents({ courseId: fisica.id })).toHaveLength(1);
    expect(() => docs.rename(d.id, '  ')).toThrow();
    expect(repo.courses()).toHaveLength(3);
  });

  it('prevents moving a folder into itself or its own descendants', async () => {
    const { docs } = await setup();
    const a = docs.createFolder('A', null);
    const b = docs.createFolder('B', a.id);
    expect(() => docs.moveFolder(a.id, b.id)).toThrow(/sottocartella/);
    expect(() => docs.moveFolder(a.id, a.id)).toThrow();
    docs.moveFolder(b.id, null);
    expect(docs.folder(b.id)!.parentId).toBeNull();
  });

  it('deleting reports the impact first and removes the stored files too', async () => {
    const { docs, files } = await setup();
    const f = docs.createFolder('Fisica', null);
    const sub = docs.createFolder('Appunti', f.id);
    const d1 = await docs.addDocument({ data: bytes('1'), fileName: 'a.md', folderId: f.id });
    await docs.addDocument({ data: bytes('2'), fileName: 'b.md', folderId: sub.id });
    expect(docs.folderDeletionImpact(f.id)).toEqual({ folders: 2, documents: 2 });
    await docs.deleteFolder(f.id);
    expect(docs.documents()).toHaveLength(0);
    expect(await files.keys()).toEqual([]);
    const lone = await docs.addDocument({ data: bytes('3'), fileName: 'c.md', folderId: null });
    await docs.delete(lone.id);
    expect(docs.document(lone.id)).toBeUndefined();
    expect(await files.has(lone.storageKey)).toBe(false);
    expect(d1.id).toBeTruthy();
  });

  it('keeps the database consistent if the file cannot be stored', async () => {
    const { docs, files } = await setup();
    files.put = async () => {
      throw new Error('disco pieno');
    };
    await expect(docs.addDocument({ data: bytes('x'), fileName: 'a.md', folderId: null })).rejects.toThrow('disco pieno');
    expect(docs.documents()).toHaveLength(0);
  });

  it('searches names and note contents, tracks recents, remembers PDF position and bookmarks', async () => {
    const { docs } = await setup();
    const n = await docs.addDocument({ data: bytes('# Ampère\nLa circuitazione del campo magnetico è proporzionale alla corrente.'), fileName: 'Ampère.md', folderId: null });
    const p = await docs.addDocument({ data: bytes('%PDF'), fileName: 'Mazzoldi.pdf', folderId: null });
    expect(docs.search('circuitazione').map((r) => r.doc.id)).toEqual([n.id]);
    expect(docs.search('circuitazione')[0].snippet).toContain('circuitazione');
    expect(docs.search('mazz').map((r) => r.doc.id)).toEqual([p.id]);
    expect(docs.search('100%')).toEqual([]); // LIKE wildcards are escaped
    expect(docs.recentDocuments()).toHaveLength(0);
    docs.markOpened(p.id);
    expect(docs.recentDocuments().map((d) => d.id)).toEqual([p.id]);
    docs.savePdfState(p.id, 212, 1.25);
    expect(docs.pdfState(p.id)).toMatchObject({ lastPage: 212, zoom: 1.25 });
    docs.savePdfState(p.id, 213, 0);
    expect(docs.pdfState(p.id)!.lastPage).toBe(213);
    const b1 = docs.addBookmark(p.id, 40, 'Teorema');
    expect(docs.addBookmark(p.id, 40).id).toBe(b1.id); // no duplicates
    docs.addBookmark(p.id, 12);
    expect(docs.bookmarks(p.id).map((b) => b.page)).toEqual([12, 40]);
    docs.removeBookmark(b1.id);
    expect(docs.bookmarks(p.id)).toHaveLength(1);
  });

  it('documents survive a backup and restore', async () => {
    const { docs, db, files } = await setup();
    const f = docs.createFolder('Fisica 2', null);
    const n = await docs.addDocument({ data: bytes('# Nota'), fileName: 'n.md', folderId: f.id });
    docs.savePdfState(n.id, 5, 1);
    const archive = new Uint8Array(await (await createArchive(db, files)).arrayBuffer());
    const dest = await makeRepo();
    const destFiles = new MemoryFileStore();
    await restoreArchive(dest.db, destFiles, archive);
    const d2 = new DocsRepo(dest.repo, destFiles);
    expect(d2.pathIndex().map((e) => e.path)).toEqual(['Fisica 2/n.md']);
    expect(await d2.getText(n.id)).toBe('# Nota');
    expect(d2.pdfState(n.id)!.lastPage).toBe(5);
  });

  it('finds the notes that cite a note with a wiki-link (alias and heading forms included), not look-alikes', async () => {
    const { docs } = await setup();
    const target = await docs.addDocument({ data: bytes('# Formulario'), fileName: 'Formulario.md', folderId: null });
    const a = await docs.addDocument({ data: bytes('vedi [[Formulario]] e [[formulario|il mio formulario]]'), fileName: 'A.md', folderId: null });
    const b = await docs.addDocument({ data: bytes('vedi [[Formulario#Magnetismo]]'), fileName: 'B.md', folderId: null });
    await docs.addDocument({ data: bytes('vedi [[Formulario esteso]]'), fileName: 'C.md', folderId: null }); // different note
    await docs.addDocument({ data: bytes('niente link, solo la parola Formulario'), fileName: 'D.md', folderId: null });
    expect(docs.backlinks(target).map((d) => d.id).sort()).toEqual([a.id, b.id].sort());
    expect(docs.backlinks(a)).toEqual([]);
  });
});
