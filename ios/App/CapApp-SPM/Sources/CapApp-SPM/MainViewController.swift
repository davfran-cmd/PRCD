import UIKit
import Capacitor

/// Root view controller of the app: Capacitor's bridge plus PRCD's two local plugins.
/// (Plugins that live in the app itself, not in an npm package, must be registered by hand.)
@objc(MainViewController)
public class MainViewController: CAPBridgeViewController {
    override public func capacitorDidLoad() {
        bridge?.registerPluginInstance(PRCDCalendarPlugin())
        bridge?.registerPluginInstance(PRCDFilesPlugin())
    }
}
