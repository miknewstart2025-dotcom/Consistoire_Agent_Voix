package com.hotelos.dpc

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import com.hotelos.dpc.core.ApkArtifact
import com.hotelos.dpc.core.PackageInstallerPort
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

/**
 * Silent install as Device Owner (PackageInstaller session, no user confirmation).
 * Before committing: sha256 of the file, package name and signing certificate are checked
 * against the signed policy. Download resumes after interruption (HTTP Range).
 * [HW-REQUIRED] silent install behaviour must be confirmed per certified model.
 */
class ApkInstaller(private val context: Context, private val http: OkHttpClient) : PackageInstallerPort {
    private val dir = File(context.cacheDir, "apk").apply { mkdirs() }

    override suspend fun installOrUpdate(packageName: String, artifact: ApkArtifact): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val file = File(dir, "$packageName-${artifact.versionCode}.apk")
            download(artifact.url, file, artifact.sizeBytes)
            val digest = sha256(file)
            if (digest != artifact.sha256) { file.delete(); error("sha256 mismatch for $packageName") }
            val info = context.packageManager.getPackageArchiveInfo(file.path, PackageManager.GET_SIGNING_CERTIFICATES)
                ?: error("unreadable APK for $packageName")
            if (info.packageName != packageName) error("APK package ${info.packageName} != expected $packageName")
            if (info.longVersionCode != artifact.versionCode) error("APK versionCode ${info.longVersionCode} != ${artifact.versionCode}")
            val signer = info.signingInfo?.apkContentsSigners?.firstOrNull()?.let { AndroidDevicePlatform.sha256(it.toByteArray()) }
            if (signer != artifact.signerSha256) error("signing certificate mismatch for $packageName")
            commit(file, packageName)
            file.delete()
        }
    }

    override suspend fun uninstall(packageName: String): Result<Unit> = runCatching {
        val (id, deferred) = register()
        context.packageManager.packageInstaller.uninstall(packageName, pendingIntent(id).intentSender)
        withTimeout(120_000) { deferred.await() }.getOrThrow()
    }

    private fun download(url: String, file: File, expectedSize: Long) {
        val start = if (file.exists()) file.length() else 0L
        if (start == expectedSize) return
        val req = Request.Builder().url(url).apply { if (start > 0) header("Range", "bytes=$start-") }.build()
        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) error("download failed: HTTP ${resp.code}")
            val append = resp.code == 206
            file.outputStream().let { if (append) java.io.FileOutputStream(file, true) else it }.use { out ->
                resp.body!!.byteStream().copyTo(out)
            }
        }
        if (file.length() != expectedSize) error("incomplete download: ${file.length()}/$expectedSize")
    }

    private suspend fun commit(file: File, packageName: String) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(packageName)
            if (android.os.Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val sessionId = installer.createSession(params)
        val (id, deferred) = register()
        installer.openSession(sessionId).use { session ->
            session.openWrite("base.apk", 0, file.length()).use { out -> file.inputStream().use { it.copyTo(out) }; session.fsync(out) }
            session.commit(pendingIntent(id).intentSender)
        }
        withTimeout(300_000) { deferred.await() }.getOrThrow()
    }

    private fun register(): Pair<Int, CompletableDeferred<Result<Unit>>> {
        val id = nextId++
        val d = CompletableDeferred<Result<Unit>>()
        pending[id] = d
        return id to d
    }

    private fun pendingIntent(id: Int) = PendingIntent.getBroadcast(
        context, id,
        Intent(context, InstallResultReceiver::class.java).putExtra(EXTRA_ID, id),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
    )

    companion object {
        const val EXTRA_ID = "hotelos.install.id"
        internal val pending = ConcurrentHashMap<Int, CompletableDeferred<Result<Unit>>>()
        @Volatile private var nextId = 1000
        fun sha256(f: File): String {
            val md = MessageDigest.getInstance("SHA-256")
            f.inputStream().use { input -> val buf = ByteArray(64 * 1024); while (true) { val n = input.read(buf); if (n < 0) break; md.update(buf, 0, n) } }
            return md.digest().joinToString("") { "%02x".format(it) }
        }
    }
}

class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getIntExtra(ApkInstaller.EXTRA_ID, -1)
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val d = ApkInstaller.pending.remove(id) ?: return
        when (status) {
            PackageInstaller.STATUS_SUCCESS -> d.complete(Result.success(Unit))
            // As Device Owner this should not happen; if it does the firmware does not grant silent install.
            PackageInstaller.STATUS_PENDING_USER_ACTION -> d.complete(Result.failure(IllegalStateException("silent install refused: user action required on this model")))
            else -> d.complete(Result.failure(IllegalStateException(intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "install failed ($status)")))
        }
    }
}
