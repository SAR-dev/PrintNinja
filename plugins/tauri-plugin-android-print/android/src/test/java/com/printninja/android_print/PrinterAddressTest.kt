package com.printninja.android_print

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PrinterAddressTest {

    @Test
    fun ipv4HostIsUnchanged() {
        assertEquals("192.168.1.20", PrinterAddress.formatHost("192.168.1.20"))
    }

    @Test
    fun ipv6HostIsBracketed() {
        assertEquals("[2001:db8::1]", PrinterAddress.formatHost("2001:db8::1"))
    }

    @Test
    fun ipv6ScopeIsDropped() {
        assertEquals("[fe80::1]", PrinterAddress.formatHost("fe80::1%wlan0"))
        assertEquals("[fe80:0:0:0:1:2:3:4]", PrinterAddress.formatHost("fe80:0:0:0:1:2:3:4%2"))
    }

    @Test
    fun anAlreadyBracketedHostIsNotBracketedTwice() {
        assertEquals("[::1]", PrinterAddress.formatHost("[::1]"))
    }

    @Test
    fun normalResourcePathIsKept() {
        assertEquals("printers/Office", PrinterAddress.resourcePath("printers/Office".toByteArray()))
    }

    @Test
    fun leadingSlashIsStripped() {
        assertEquals("ipp/print", PrinterAddress.resourcePath("/ipp/print".toByteArray()))
    }

    @Test
    fun missingOrBlankResourcePathIsNull() {
        assertNull(PrinterAddress.resourcePath(null))
        assertNull(PrinterAddress.resourcePath("".toByteArray()))
        assertNull(PrinterAddress.resourcePath("  /  ".toByteArray()))
    }
}
