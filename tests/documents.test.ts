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
  it('imports a folder tree of PDFs preserving the hierarchy, and never modifies the source bytes', async () => {
    const { docs, files } = await setup();
    const src = '%PDF-1.4 ampere';
    const report = await docs.importTree(
      [entry('Appunti/14 Legge di Ampère.pdf', src), entry('Slide/magnetostatica.pdf', '%PDF-1.4 x'), entry('Formulario.pdf', '%PDF-1.4 f')],
      { parentFolderId: null, rootName: 'Fisica 2' },
    );
    expect(report.added).toBe(3);
    expect(report.errors).toEqual([]);
    const index = docs.pathIndex().map((e) => e.path).sort();
    expect(index).toEqual(['Fisica 2/Appunti/14 Legge di Ampère.pdf', 'Fisica 2/Formulario.pdf', 'Fisica 2/Slide/magnetostatica.pdf']);
    const pdf = docs.documents().find((d) => d.fileName.startsWith('14'))!;
    expect(new TextDecoder().decode(await (await docs.getBlob(pdf.id)).arrayBuffer())).toBe(src); // byte for byte
    expect(pdf.kind).toBe('pdf');
    expect(await files.has(pdf.storageKey)).toBe(true);
    expect(docs.folderPath(pdf.folderId).map((f) => f.name)).toEqual(['Fisica 2', 'Appunti']);
  });

  it('imports PDFs and Markdown notes (images only with notes); hidden/system files and other types are skipped', async () => {
    const { docs } = await setup();
    const r = await docs.importTree([entry('vault/.obsidian/app.json'), entry('vault/.DS_Store'), entry('vault/nota.md'), entry('vault/foto.png'), entry('vault/dispensa.pdf'), entry('vault/archivio.zip'), entry('__MACOSX/x.pdf')], { parentFolderId: null });
    expect(r.added).toBe(3);
    expect(r.skipped.map((s) => s.path).sort()).toEqual(['__MACOSX/x.pdf', 'vault/.DS_Store', 'vault/.obsidian/app.json', 'vault/archivio.zip']);
    const alone = await docs.importTree([entry('foto2.png')], { parentFolderId: null });
    expect(alone.added).toBe(0); // an image on its own is not imported
    expect(isIgnoredPath('a/.git/config')).toBe(true);
    expect(isIgnoredPath('a/b.md')).toBe(false);
    expect(kindOf('x.PDF')).toBe('pdf');
    expect(kindOf('x.JPG')).toBe('image');
  });

  it('reuses a folder whose name differs only by case, spaces or Unicode form: no "Università (2)"', async () => {
    const { docs } = await setup();
    docs.createFolder('Università', null);
    const nfd = 'Universita\u0300';
    await docs.importTree([entry(`${nfd}/Fisica/a.pdf`), entry('università /Fisica/b.pdf'), entry('UNIVERSITÀ/fisica/c.pdf')], { parentFolderId: null });
    expect(docs.folders(null).map((f) => f.name)).toEqual(['Università']);
    expect(docs.folders(docs.folders(null)[0].id).map((f) => f.name)).toEqual(['Fisica']);
    expect(docs.documents()).toHaveLength(3);
  });

  it('never overwrites: a name collision gets a suffix and both files survive', async () => {
    const { docs } = await setup();
    const a = await docs.addDocument({ data: bytes('uno'), fileName: 'Nota.md', folderId: null });
    const b = await docs.addDocument({ data: bytes('due'), fileName: 'Nota.md', folderId: null });
    expect(b.fileName).toBe('Nota (2).md');
    expect(await docs.getText(a.id)).toBe('uno');
    expect(await docs.getText(b.id)).toBe('due');
    await docs.addDocument({ data: bytes('%PDF uno'), fileName: 'Dispensa.pdf', folderId: null });
    const again = await docs.importTree([entry('Dispensa.pdf', '%PDF due')], { parentFolderId: null });
    expect(again.renamed).toEqual([{ from: 'Dispensa.pdf', to: 'Dispensa (2).pdf' }]);
  });

  it('gives every course one folder (never duplicated) and links what is inside it to the course', async () => {
    const { docs, repo, fisica } = await setup();
    const plain = docs.createFolder(fisica.name, null); // an existing folder with the course name is adopted
    docs.ensureCourseFolders();
    docs.ensureCourseFolders();
    const mine = docs.folders(null).filter((f) => f.courseId === fisica.id);
    expect(mine.map((f) => f.id)).toEqual([plain.id]);
    expect(docs.folders(null).filter((f) => f.courseId).length).toBe(repo.courses().length);
    // a PDF added inside a subfolder of the course folder belongs to the course
    const sub = docs.createFolder('Esercizi', plain.id);
    const d = await docs.addDocument({ data: bytes('%PDF'), fileName: 'es1.pdf', folderId: sub.id });
    expect(d.courseId).toBe(fisica.id);
    // moved out of the course folder: unlinked; moved back in: linked again
    docs.move(d.id, null);
    expect(docs.document(d.id)!.courseId).toBeNull();
    const other = docs.createFolder('Varie', null);
    docs.move(d.id, other.id);
    docs.moveFolder(other.id, plain.id);
    expect(docs.document(d.id)!.courseId).toBe(fisica.id);
  });

  it('deletes a selection of folders (with their content) and documents in one go', async () => {
    const { docs, files } = await setup();
    const keep = await docs.addDocument({ data: bytes('%PDF k'), fileName: 'tieni.pdf', folderId: null });
    const ids: string[] = [];
    for (let i = 2; i <= 5; i++) {
      const f = docs.createFolder(`Università (${i})`, null);
      ids.push(f.id);
      await docs.addDocument({ data: bytes('# n'), fileName: 'n.md', folderId: docs.createFolder('Fisica', f.id).id });
    }
    const loose = await docs.addDocument({ data: bytes('%PDF x'), fileName: 'via.pdf', folderId: null });
    expect(docs.selectionImpact(ids, [loose.id])).toEqual({ folders: 8, documents: 5 });
    const r = await docs.deleteMany(ids, [loose.id]);
    expect(r).toEqual({ folders: 8, documents: 5 });
    expect(docs.folders().filter((f) => f.name.startsWith('Università'))).toHaveLength(0);
    expect(docs.documents().map((d) => d.id)).toContain(keep.id);
    expect(await files.has(loose.storageKey)).toBe(false);
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
