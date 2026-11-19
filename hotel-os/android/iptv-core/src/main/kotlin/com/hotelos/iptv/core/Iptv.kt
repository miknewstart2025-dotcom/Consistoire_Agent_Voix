package com.hotelos.iptv.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.time.Instant

val IptvJson = Json { ignoreUnknownKeys = true }

@Serializable
data class Channel(
    val id: String,
    val number: Int,
    val name: String,
    val epgId: String? = null,
    val logoUrl: String? = null,
    val category: String? = null,
    val language: String? = null,
    val streamUrl: String,
)

@Serializable data class Lineup(val generatedAt: String, val channels: List<Channel>)

@Serializable
data class Programme(val epgId: String, val start: String, val stop: String, val title: String, val description: String? = null, val category: String? = null)

@Serializable data class EpgWindow(val from: String, val to: String, val programmes: List<Programme>)

/** Index for fast "now / next" lookups on low-end boxes. */
class EpgIndex(window: EpgWindow) {
    private val byChannel: Map<String, List<Triple<Instant, Instant, Programme>>> =
        window.programmes.groupBy { it.epgId }.mapValues { (_, ps) -> ps.map { Triple(Instant.parse(it.start), Instant.parse(it.stop), it) }.sortedBy { it.first } }

    fun nowNext(epgId: String?, at: Instant): Pair<Programme?, Programme?> {
        val list = epgId?.let { byChannel[it] } ?: return null to null
        val idx = list.indexOfFirst { at >= it.first && at < it.second }
        if (idx >= 0) return list[idx].third to list.getOrNull(idx + 1)?.third
        return null to list.firstOrNull { it.first > at }?.third
    }

    fun schedule(epgId: String?, from: Instant, to: Instant): List<Programme> =
        epgId?.let { byChannel[it] }?.filter { it.second > from && it.first < to }?.map { it.third } ?: emptyList()
}

/** Remote-control navigation over the lineup: up/down, direct number entry, favourites, categories. */
class Zapper(channels: List<Channel>) {
    val channels = channels.sortedBy { it.number }
    var index = 0
        private set
    val current get() = channels.getOrNull(index)
    val categories: List<String> get() = channels.mapNotNull { it.category }.distinct().sorted()

    fun next(): Channel? { if (channels.isNotEmpty()) index = (index + 1) % channels.size; return current }
    fun previous(): Channel? { if (channels.isNotEmpty()) index = (index - 1 + channels.size) % channels.size; return current }
    /** Exact number, or the closest higher number (typical TV behaviour). */
    fun tune(number: Int): Channel? {
        val i = channels.indexOfFirst { it.number >= number }
        if (i >= 0) index = i
        return current
    }
    fun select(id: String): Channel? { channels.indexOfFirst { it.id == id }.takeIf { it >= 0 }?.let { index = it }; return current }
    fun inCategory(cat: String?) = if (cat == null) channels else channels.filter { it.category == cat }
    fun search(q: String) = channels.filter { it.name.contains(q.trim(), ignoreCase = true) || it.number.toString() == q.trim() }
}

/** Collects digits typed on the remote; commits after a pause. */
class NumberEntry(private val maxDigits: Int = 4) {
    private val sb = StringBuilder()
    val pending get() = sb.toString()
    fun digit(d: Int): String { if (sb.length >= maxDigits) sb.clear(); sb.append(d); return pending }
    fun commit(): Int? = pending.toIntOrNull().also { sb.clear() }
}

/** Retry schedule for a failing stream: 1s, 2s, 4s, 8s, then give up and offer another channel. */
object StreamRetry {
    const val MAX_ATTEMPTS = 4
    fun delayMs(attempt: Int): Long? = if (attempt >= MAX_ATTEMPTS) null else 1000L shl attempt
}

/** Favourites belong to the guest session: reset at checkout (RESET_SESSION). */
class Favourites(initial: Set<String> = emptySet()) {
    private val ids = initial.toMutableSet()
    fun toggle(id: String): Boolean = if (!ids.add(id)) { ids.remove(id); false } else true
    fun contains(id: String) = id in ids
    fun all(): Set<String> = ids.toSet()
    fun clear() = ids.clear()
}
