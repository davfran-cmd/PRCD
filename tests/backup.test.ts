import { describe, expect, it } from 'vitest';
import { ArchiveError, createArchive, eraseAllData, inspectArchive, restoreArchive, dumpJson } from '../src/db/backup';
import { Database } from '../src/db/database';
import { Repo } from '../src/db/repo';
import { MemoryFileStore } from '../src/storage/fileStore';
import { insertRow } from '../src/db/rows';
import { clockAt, makeRepo, seedDesign } from './helpers';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

async function populated() {
  const ctx = await seedDesign();
  const files = new MemoryFileStore();
  const pdf = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10, 1, 2, 3, 4, 5]);
  await files.put('f/doc-1', pdf);
  insertRow(ctx.db, 'documents', {
    id: 'doc-1', folderId: null, name: 'Mazzoldi', fileName: 'Mazzoldi.pdf', kind: 'pdf', mime: 'application/pdf', size: pdf.length, storageKey: 'f/doc-1',
    courseId: ctx.fisica.id, favorite: true, tags: ['esame'], pageCount: 400, addedAt: 'x', lastOpenedAt: null, updatedAt: 'x',
  }, { bool: ['favorite'], json: ['tags'] });
  const lesson = ctx.repo.lessonsForCourse(ctx.fisica.id)[0];
  ctx.repo.setAttendance(lesson.id, 'attended');
  ctx.repo.saveAttempt({ courseId: ctx.fisica.id, outcome: 'passed', grade: 28, date: '2027-01-19' });
  return { ...ctx, files, pdf, lesson };
}

describe('backup and restore', () => {
  it('exports everything and restores it into an empty app, byte for byte', async () => {
    const src = await populated();
    const archive = await bytesOf(await createArchive(src.db, src.files));

    const dest = await makeRepo(clockAt(2026, 11, 16));
    const destFiles = new MemoryFileStore();
    const report = await restoreArchive(dest.db, destFiles, archive);
    expect(report.documents).toBe(1);
    expect(dest.repo.courses().map((c) => c.name).sort()).toEqual(['Analisi 2', 'Fisica 2', 'Meccanica razionale']);
    expect(dest.repo.lesson(src.lesson.id)!.attendance).toBe('attended');
    expect(dest.repo.attempts(src.fisica.id)[0].grade).toBe(28);
    expect(dest.repo.lessonsForCourse(src.fisica.id)).toHaveLength(src.repo.lessonsForCourse(src.fisica.id).length);
    expect(Array.from(new Uint8Array(await (await destFiles.get('f/doc-1'))!.arrayBuffer()))).toEqual(Array.from(src.pdf));
    expect(dest.db.integrityCheck()).toBe('ok');
  });

  it('keeps the previous data as a snapshot when restoring over existing data', async () => {
    const src = await populated();
    const archive = await bytesOf(await createArchive(src.db, src.files));
    const dest = await makeRepo(clockAt(2026, 11, 16));
    dest.repo.createSemester({ name: 'Mio semestre', startDate: '2025-09-01', endDate: '2026-01-31' });
    await restoreArchive(dest.db, new MemoryFileStore(), archive, { now: new Date('2026-11-20T10:00:00Z') });
    const snaps = await dest.persistence.listSnapshots();
    expect(snaps.map((s) => s.name)).toContain('pre-restore-2026-11-20T10-00-00-000Z');
    const old = await Database.fromBytes((await dest.persistence.loadSnapshot('pre-restore-2026-11-20T10-00-00-000Z'))!);
    expect(new Repo(old).semesters().map((s) => s.name)).toEqual(['Mio semestre']); // nothing was lost
  });

  it('writes a manifest with checksums and a readable JSON dump', async () => {
    const src = await populated();
    const archive = await bytesOf(await createArchive(src.db, src.files, { appVersion: '9.9.9' }));
    const entries = unzipSync(archive);
    expect(Object.keys(entries).sort()).toEqual(['data.json', 'database.sqlite', 'files/f/doc-1', 'manifest.json']);
    const manifest = JSON.parse(strFromU8(entries['manifest.json']));
    expect(manifest).toMatchObject({ format: 'prcd-archive', version: 1, appVersion: '9.9.9', schemaVersion: 1 });
    expect(manifest.files[0]).toMatchObject({ key: 'f/doc-1', size: src.pdf.length });
    expect(manifest.files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    const data = JSON.parse(strFromU8(entries['data.json']));
    expect(data.courses).toHaveLength(3);
    expect(Object.keys(dumpJson(src.db))).toContain('lessons');
  });

  it('rejects a corrupted file and changes nothing', async () => {
    const src = await populated();
    const entries = unzipSync(await bytesOf(await createArchive(src.db, src.files)));
    entries['files/f/doc-1'] = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]); // same size, different content
    const bad = zipSync(entries);
    const dest = await makeRepo(clockAt(2026, 11, 16));
    dest.repo.createSemester({ name: 'Tengo questo', startDate: '2025-09-01', endDate: '2026-01-31' });
    const destFiles = new MemoryFileStore();
    await expect(restoreArchive(dest.db, destFiles, bad)).rejects.toThrow(/checksum/);
    expect(dest.repo.semesters().map((s) => s.name)).toEqual(['Tengo questo']);
    expect(await destFiles.keys()).toEqual([]);
    expect(await dest.persistence.listSnapshots()).toEqual([]); // not even a snapshot: verification failed first
  });

  it('rejects random bytes, missing parts and archives from the future', async () => {
    await expect(inspectArchive(new Uint8Array([1, 2, 3, 4]))).rejects.toBeInstanceOf(ArchiveError);
    await expect(inspectArchive(zipSync({ 'x.txt': strToU8('hi') }))).rejects.toThrow(/manifest/);
    const src = await populated();
    const entries = unzipSync(await bytesOf(await createArchive(src.db, src.files)));
    const m = JSON.parse(strFromU8(entries['manifest.json']));
    const future = zipSync({ ...entries, 'manifest.json': strToU8(JSON.stringify({ ...m, schemaVersion: 99 })) });
    await expect(inspectArchive(future)).rejects.toThrow(/più recenti/);
    const missing = { ...entries };
    delete missing['files/f/doc-1'];
    await expect(inspectArchive(zipSync(missing))).rejects.toThrow(/manca il file/);
    const notDb = zipSync({ ...entries, 'database.sqlite': strToU8('this is not a database') });
    await expect(inspectArchive(notDb)).rejects.toBeInstanceOf(ArchiveError);
  });

  it('refuses to create a backup when a referenced file is missing (no silent partial backup)', async () => {
    const src = await populated();
    await src.files.delete('f/doc-1');
    await expect(createArchive(src.db, src.files)).rejects.toThrow(/mancante/);
  });

  it('erasing everything keeps a snapshot that can be restored', async () => {
    const src = await populated();
    const name = await eraseAllData(src.db, src.files, { now: new Date('2026-11-21T08:00:00Z') });
    expect(new Repo(src.db).courses()).toHaveLength(0);
    expect(await src.files.keys()).toEqual([]);
    expect(name).toBe('pre-erase-2026-11-21T08-00-00-000Z');
    const snap = await Database.fromBytes((await src.persistence.loadSnapshot(name))!);
    expect(new Repo(snap).courses()).toHaveLength(3);
  });
});
