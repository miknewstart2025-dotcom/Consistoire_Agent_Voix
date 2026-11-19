// Bound by HOTEL LAUNCHER / HOTEL IPTV only (permission com.hotelos.permission.DEVICE_SERVICE, protectionLevel=signature).
package com.hotelos.dpc;

interface IHotelDevice {
    /** EffectivePolicy JSON (already verified by the controller), or null before the first policy. */
    String getPolicyJson();
    /** Short-lived JWT the app may use against the HOTEL OS API (same device identity, never the key). */
    String getDelegatedToken();
    /** Base URL of the HOTEL OS API (for data-plane calls with the delegated token). */
    String getApiBaseUrl();
    /** Launcher liveness signal for the watchdog. */
    void heartbeat(String packageName, int versionCode);
    /** Launch an app only if the current policy allows it. Returns false otherwise. */
    boolean launchAllowedApp(String packageName);
}
