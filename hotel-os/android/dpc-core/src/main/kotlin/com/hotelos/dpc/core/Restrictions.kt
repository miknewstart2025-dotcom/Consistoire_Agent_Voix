package com.hotelos.dpc.core

/** UserManager.DISALLOW_* keys the controller manages (values = Android constant strings). */
object Restrictions {
    val MANAGED: Set<String> = setOf(
        "no_install_apps",
        "no_install_unknown_sources",
        "no_install_unknown_sources_globally",
        "no_uninstall_apps",
        "no_factory_reset",
        "no_safe_boot",
        "no_debugging_features",
        "no_config_wifi",
        "no_config_bluetooth",
        "no_modify_accounts",
        "no_add_user",
        "no_physical_media",
        "no_usb_file_transfer",
        "no_config_date_time",
        "no_control_apps",
        "no_network_reset",
    )
    /** Lifted while a technician holds a maintenance session. Debugging stays possible for ADB diagnostics. */
    val LIFTED_IN_MAINTENANCE: Set<String> = setOf("no_debugging_features", "no_config_wifi", "no_config_date_time", "no_config_bluetooth")
}

/** Never touched by policy, whatever the server says (defence in depth; the server filters too). */
val PROTECTED_PACKAGES: Set<String> = setOf(
    "com.hotelos.dpc",
    "com.hotelos.launcher",
    "android",
    "com.android.systemui",
    "com.android.packageinstaller",
    "com.google.android.packageinstaller",
    "com.android.permissioncontroller",
    "com.google.android.permissioncontroller",
    "com.android.providers.settings",
)
