package com.printninja.android_print

/**
 * Pure helpers that turn what mDNS reports into the pieces of a printer
 * address. No Android classes, so plain JUnit covers them.
 */
object PrinterAddress {
    /**
     * A host that can sit in front of `:port`. An IPv6 literal is wrapped
     * in brackets and loses its `%interface` scope (the scope is local to
     * the phone and breaks the address); an IPv4 literal or name is
     * returned unchanged.
     */
    fun formatHost(raw: String): String {
        val host = raw.trim().substringBefore('%')
        if (host.startsWith("[")) return host
        return if (host.contains(':')) "[$host]" else host
    }

    /**
     * The `rp` TXT value as a path without a leading slash, or null when
     * it is missing or blank. The caller (Rust) falls back to `ipp/print`.
     */
    fun resourcePath(rp: ByteArray?): String? {
        val path = rp?.toString(Charsets.UTF_8)?.trim()?.trimStart('/') ?: return null
        return path.ifEmpty { null }
    }
}
