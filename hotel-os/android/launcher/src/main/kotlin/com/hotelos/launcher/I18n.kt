package com.hotelos.launcher

/** UI chrome strings. Hotel content (welcome message…) comes translated from the policy. */
object I18n {
    val RTL = setOf("he", "ar")
    private val s: Map<String, Map<String, String>> = mapOf(
        "fr" to mapOf("room" to "Chambre", "apps" to "Applications", "welcome" to "Bienvenue", "language" to "Langue", "unavailable" to "Indisponible pour le moment", "starting" to "Démarrage…"),
        "en" to mapOf("room" to "Room", "apps" to "Apps", "welcome" to "Welcome", "language" to "Language", "unavailable" to "Currently unavailable", "starting" to "Starting…"),
        "he" to mapOf("room" to "חדר", "apps" to "אפליקציות", "welcome" to "ברוכים הבאים", "language" to "שפה", "unavailable" to "לא זמין כרגע", "starting" to "מתחיל…"),
        "ar" to mapOf("room" to "الغرفة", "apps" to "التطبيقات", "welcome" to "أهلاً وسهلاً", "language" to "اللغة", "unavailable" to "غير متاح حالياً", "starting" to "جارٍ البدء…"),
        "es" to mapOf("room" to "Habitación", "apps" to "Aplicaciones", "welcome" to "Bienvenido", "language" to "Idioma", "unavailable" to "No disponible por el momento", "starting" to "Iniciando…"),
        "it" to mapOf("room" to "Camera", "apps" to "App", "welcome" to "Benvenuto", "language" to "Lingua", "unavailable" to "Momentaneamente non disponibile", "starting" to "Avvio…"),
        "de" to mapOf("room" to "Zimmer", "apps" to "Apps", "welcome" to "Willkommen", "language" to "Sprache", "unavailable" to "Derzeit nicht verfügbar", "starting" to "Wird gestartet…"),
    )
    val NATIVE_NAMES = mapOf("fr" to "Français", "en" to "English", "he" to "עברית", "ar" to "العربية", "es" to "Español", "it" to "Italiano", "de" to "Deutsch")
    fun t(lang: String, key: String) = s[lang]?.get(key) ?: s["en"]!![key] ?: key
}
