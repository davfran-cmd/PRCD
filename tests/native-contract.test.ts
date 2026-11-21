import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The Swift plugins cannot be compiled on this machine (no Xcode), so this test guards the *contract*:
 * every method and JSON field the TypeScript side relies on must exist in the Swift sources, and the safety
 * rules that must hold natively are still present. It does NOT replace building and running on a device.
 */
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SWIFT = 'ios/App/CapApp-SPM/Sources/CapApp-SPM';
const calendarSwift = read(`${SWIFT}/PRCDCalendarPlugin.swift`);
const filesSwift = read(`${SWIFT}/PRCDFilesPlugin.swift`);
const bridgeTs = read('src/calendar/bridge.ts');
const importTs = read('src/documents/importSources.ts');

const swiftMethods = (src: string) => [...src.matchAll(/CAPPluginMethod\(name: "(\w+)"/g)].map((m) => m[1]).sort();
const swiftFuncs = (src: string) => [...src.matchAll(/@objc func (\w+)\(_ call: CAPPluginCall\)/g)].map((m) => m[1]).sort();

describe('native plugin contract (static check)', () => {
  it('PRCDCalendar exposes exactly the methods the TypeScript bridge calls', () => {
    const used = [...bridgeTs.matchAll(/this\.plugin\.(\w+)\(/g)].map((m) => m[1]).filter((m) => m !== 'addListener');
    const expected = [...new Set(used)].sort();
    expect(swiftMethods(calendarSwift)).toEqual(expected);
    expect(swiftFuncs(calendarSwift)).toEqual(expected); // every declared method has an @objc implementation
    expect(calendarSwift).toContain('jsName = "PRCDCalendar"');
    expect(bridgeTs).toContain("registerPlugin<PRCDCalendarPlugin>('PRCDCalendar')");
  });

  it('PRCDCalendar emits the storeChanged event and returns every field of NativeEvent / NativeCalendar', () => {
    expect(calendarSwift).toContain('notifyListeners("storeChanged"');
    expect(bridgeTs).toContain("addListener('storeChanged'");
    for (const key of ['ekEventId', 'externalId', 'calendarId', 'title', 'notes', 'location', 'start', 'end', 'allDay', 'url', 'lastModified']) {
      expect(calendarSwift, `event field ${key}`).toContain(`"${key}"`);
    }
    for (const key of ['id', 'title', 'sourceTitle', 'color', 'allowsModifications', 'isSubscribed']) {
      expect(calendarSwift, `calendar field ${key}`).toContain(`"${key}"`);
    }
    for (const status of ['notDetermined', 'denied', 'restricted', 'writeOnly', 'fullAccess']) expect(calendarSwift).toContain(`"${status}"`);
  });

  it('keeps the native safety rules: only PRCD-marked events are changed, full access is required, writes go through EventKit once', () => {
    expect(calendarSwift).toContain('NOT_PRCD_EVENT');
    expect(calendarSwift).toContain('markerPrefix = "prcd://"');
    expect(calendarSwift).toContain('requestFullAccessToEvents'); // iOS 17+ API
    expect(calendarSwift).toContain('requestAccess(to: .event'); // fallback for iOS 15-16
    expect(calendarSwift).toContain('ACCESS_DENIED');
    expect(calendarSwift).not.toMatch(/removeCalendar|saveCalendar\(.*commit:\s*false/); // never deletes calendars
    // updateEvent and deleteEvent both check isPRCD before touching an event
    for (const fn of ['updateEvent', 'deleteEvent']) {
      const body = calendarSwift.split(`@objc func ${fn}`)[1]?.split('@objc func')[0] ?? '';
      expect(body, fn).toContain('isPRCD');
    }
  });

  it('PRCDFiles exposes pickFolder and cleanup, and never writes to the picked folder', () => {
    expect(swiftMethods(filesSwift)).toEqual(['cleanup', 'pickFolder']);
    expect(filesSwift).toContain('jsName = "PRCDFiles"');
    expect(importTs).toContain("registerPlugin<PRCDFilesPlugin>('PRCDFiles')");
    expect(filesSwift).toContain('asCopy: false');
    expect(filesSwift).not.toMatch(/removeItem\(at: folder|createDirectory\(at: folder|copyItem\(at: [^,]+, to: folder/);
  });

  it('registers both plugins and uses the registering view controller as the root', () => {
    const main = read(`${SWIFT}/MainViewController.swift`);
    expect(main).toContain('registerPluginInstance(PRCDCalendarPlugin())');
    expect(main).toContain('registerPluginInstance(PRCDFilesPlugin())');
    expect(read('ios/App/App/SceneDelegate.swift')).toContain('MainViewController()');
  });

  it('declares the Calendar permission texts required by iOS (full access + legacy key)', () => {
    const plist = read('ios/App/App/Info.plist');
    expect(plist).toContain('NSCalendarsFullAccessUsageDescription');
    expect(plist).toContain('NSCalendarsUsageDescription');
    expect(plist).toMatch(/Procedo/);
  });
});
