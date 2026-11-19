package com.hotelos.launcher

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import com.hotelos.dpc.IHotelDevice
import com.hotelos.dpc.core.EffectivePolicy
import com.hotelos.dpc.core.ProtocolJson
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** Connection to HOTEL DEVICE CONTROLLER. The launcher never talks to the backend for control decisions. */
class DeviceLink(private val ctx: Context) {
    private var service: IHotelDevice? = null
    private val _policy = MutableStateFlow<EffectivePolicy?>(null)
    val policy: StateFlow<EffectivePolicy?> = _policy
    val connected get() = service != null

    private val conn = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) { service = IHotelDevice.Stub.asInterface(binder); refresh() }
        override fun onServiceDisconnected(name: ComponentName?) { service = null }
    }

    fun bind() {
        ctx.bindService(Intent("com.hotelos.dpc.BIND").setPackage("com.hotelos.dpc"), conn, Context.BIND_AUTO_CREATE)
    }
    fun unbind() = runCatching { ctx.unbindService(conn) }

    fun refresh() {
        val json = runCatching { service?.policyJson }.getOrNull() ?: return
        _policy.value = runCatching { ProtocolJson.decodeFromString(EffectivePolicy.serializer(), json) }.getOrNull()
    }

    fun heartbeat(versionCode: Int) = runCatching { service?.heartbeat(ctx.packageName, versionCode) }
    fun launch(pkg: String): Boolean = runCatching { service?.launchAllowedApp(pkg) }.getOrNull() == true
}
