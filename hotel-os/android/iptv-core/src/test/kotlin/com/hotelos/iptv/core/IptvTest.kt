package com.hotelos.iptv.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.time.Instant

class IptvTest {
    // Same shape as GET /device/v1/iptv/lineup (apps/api test/iptv.test.ts)
    private val lineupJson = """{"generatedAt":"2026-11-19T10:00:00.000Z","channels":[
        {"id":"a","number":5,"name":"Canal 5","epgId":null,"logoUrl":null,"category":"Info","language":null,"streamUrl":"udp://@239.1.1.5:1234"},
        {"id":"b","number":1,"name":"Canal 1","epgId":"ch1","logoUrl":"https://l/1.png","category":"Info","language":"fr","streamUrl":"http://s/1.m3u8"},
        {"id":"c","number":12,"name":"Sport","epgId":"sp","category":"Sport","streamUrl":"http://s/12.mpd","extra":"ignored"}]}"""

    @Test
    fun `parses server lineup and zaps with wrap-around`() {
        val z = Zapper(IptvJson.decodeFromString(Lineup.serializer(), lineupJson).channels)
        assertEquals(listOf(1, 5, 12), z.channels.map { it.number })
        assertEquals(5, z.next()!!.number)
        assertEquals(12, z.next()!!.number)
        assertEquals(1, z.next()!!.number)
        assertEquals(12, z.previous()!!.number)
        assertEquals(12, z.tune(7)!!.number)
        assertEquals(5, z.tune(5)!!.number)
        assertEquals(listOf("Info", "Sport"), z.categories)
        assertEquals(listOf("Sport"), z.search("spo").map { it.name })
    }

    @Test
    fun `number entry commits typed digits`() {
        val n = NumberEntry()
        n.digit(1); n.digit(2)
        assertEquals(12, n.commit())
        assertNull(n.commit())
    }

    @Test
    fun `now and next`() {
        val epg = EpgIndex(EpgWindow("x", "y", listOf(
            Programme("ch1", "2026-11-19T19:00:00Z", "2026-11-19T20:00:00Z", "A"),
            Programme("ch1", "2026-11-19T20:00:00Z", "2026-11-19T21:00:00Z", "B"),
            Programme("ch1", "2026-11-19T21:30:00Z", "2026-11-19T22:00:00Z", "C"),
        )))
        val (now, next) = epg.nowNext("ch1", Instant.parse("2026-11-19T20:15:00Z"))
        assertEquals("B", now!!.title); assertEquals("C", next!!.title)
        val (gapNow, gapNext) = epg.nowNext("ch1", Instant.parse("2026-11-19T21:10:00Z"))
        assertNull(gapNow); assertEquals("C", gapNext!!.title)
        assertEquals(null to null, epg.nowNext(null, Instant.now()))
        assertEquals(2, epg.schedule("ch1", Instant.parse("2026-11-19T19:30:00Z"), Instant.parse("2026-11-19T21:00:00Z")).size)
    }

    @Test
    fun `retry schedule and favourites`() {
        assertEquals(listOf(1000L, 2000L, 4000L, 8000L, null), (0..4).map { StreamRetry.delayMs(it) })
        val f = Favourites()
        assertTrue(f.toggle("a")); assertFalse(f.toggle("a")); f.toggle("b"); f.clear()
        assertTrue(f.all().isEmpty())
    }
}
