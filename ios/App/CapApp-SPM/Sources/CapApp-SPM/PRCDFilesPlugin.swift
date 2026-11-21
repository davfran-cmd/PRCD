import Foundation
import Capacitor
import UIKit
import UniformTypeIdentifiers

/// Lets the user pick a whole folder (e.g. an Obsidian vault) from the Files app and copies it, hierarchy
/// included, into a temporary directory inside the app sandbox. The JS side then reads each file and stores
/// it in PRCD's private storage; the originals are only ever READ, never modified.
///
/// Why native: iOS WKWebView ignores `<input webkitdirectory>`, so folders cannot be chosen from the web layer.
///
/// JS contract: `src/documents/importSources.ts` (`PRCDFilesPlugin`): `pickFolder()` / `cleanup({ name })`.
///
/// STATUS: written on Windows, **never compiled or run**. See docs/IOS_BUILD.md for the verification checklist.
@objc(PRCDFilesPlugin)
public class PRCDFilesPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "PRCDFilesPlugin"
    public let jsName = "PRCDFiles"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cleanup", returnType: CAPPluginReturnPromise)
    ]

    private var pendingCall: CAPPluginCall?

    private static var importRoot: URL {
        return FileManager.default.temporaryDirectory.appendingPathComponent("prcd-import", isDirectory: true)
    }

    private static func safeName(_ name: String) -> String {
        let bad = CharacterSet(charactersIn: "/\\:")
        return name.components(separatedBy: bad).joined(separator: "-")
    }

    @objc func pickFolder(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.pendingCall == nil else {
                call.reject("Un'altra selezione è già in corso.", "BUSY")
                return
            }
            guard let vc = self.bridge?.viewController else {
                call.reject("Nessuna schermata disponibile per mostrare il selettore.", "NO_VIEW")
                return
            }
            self.pendingCall = call
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder], asCopy: false)
            picker.delegate = self
            picker.allowsMultipleSelection = false
            picker.modalPresentationStyle = .formSheet
            vc.present(picker, animated: true)
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        let call = pendingCall
        pendingCall = nil
        call?.resolve(["cancelled": true, "name": "", "files": [Any]()])
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        let call = pendingCall
        pendingCall = nil
        guard let folder = urls.first, let call = call else { return }
        // Copy on a background queue: vaults can contain thousands of files and the UI must stay responsive.
        DispatchQueue.global(qos: .userInitiated).async {
            let scoped = folder.startAccessingSecurityScopedResource()
            defer { if scoped { folder.stopAccessingSecurityScopedResource() } }
            do {
                let result = try self.copyTree(from: folder)
                call.resolve(result)
            } catch {
                call.reject("Impossibile leggere la cartella: \(error.localizedDescription)", "COPY_FAILED", error)
            }
        }
    }

    private func copyTree(from folder: URL) throws -> [String: Any] {
        let fm = FileManager.default
        let name = Self.safeName(folder.lastPathComponent)
        let dest = Self.importRoot.appendingPathComponent(name, isDirectory: true)
        try? fm.removeItem(at: dest) // stale copy from an interrupted import
        try fm.createDirectory(at: dest, withIntermediateDirectories: true)

        let root = folder.standardizedFileURL.path + "/"
        var files: [[String: Any]] = []
        guard let walker = fm.enumerator(
            at: folder,
            includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants] // also skips .obsidian, .git, .DS_Store
        ) else {
            throw NSError(domain: "PRCDFiles", code: 1, userInfo: [NSLocalizedDescriptionKey: "Cartella non leggibile"])
        }
        for case let url as URL in walker {
            let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            guard values?.isRegularFile == true else { continue }
            let full = url.standardizedFileURL.path
            guard full.hasPrefix(root) else { continue }
            let relative = String(full.dropFirst(root.count))
            let target = dest.appendingPathComponent(relative)
            try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)

            // NSFileCoordinator makes iCloud Drive download a placeholder file before it is read.
            var coordinationError: NSError?
            var copyError: Error?
            NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordinationError) { readable in
                do {
                    try? fm.removeItem(at: target)
                    try fm.copyItem(at: readable, to: target)
                } catch {
                    copyError = error
                }
            }
            if let e = coordinationError ?? (copyError as NSError?) {
                // One unreadable file must not abort the whole import: skip it, JS reports what arrived.
                _ = e
                continue
            }
            files.append(["path": relative, "uri": target.absoluteString, "size": values?.fileSize ?? 0])
        }
        return ["name": name, "files": files]
    }

    /// Removes the temporary copy once JS has stored the documents in PRCD's own storage.
    @objc func cleanup(_ call: CAPPluginCall) {
        let name = Self.safeName(call.getString("name") ?? "")
        if !name.isEmpty {
            try? FileManager.default.removeItem(at: Self.importRoot.appendingPathComponent(name, isDirectory: true))
        }
        call.resolve()
    }
}
