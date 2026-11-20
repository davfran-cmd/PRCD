import { Capacitor } from '@capacitor/core';

/**
 * Hands a generated file (archive, CSV, ICS) to the user: a download on the web, the iPadOS share sheet
 * (Save to Files, AirDrop…) in the native app.
 */
export async function saveFile(name: string, data: Blob): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const [{ Filesystem, Directory }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
    const bytes = new Uint8Array(await data.arrayBuffer());
    let bin = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode(...bytes.subarray(i, i + step));
    const written = await Filesystem.writeFile({ path: `exports/${name}`, data: btoa(bin), directory: Directory.Cache, recursive: true });
    await Share.share({ title: name, url: written.uri });
    return;
  }
  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
