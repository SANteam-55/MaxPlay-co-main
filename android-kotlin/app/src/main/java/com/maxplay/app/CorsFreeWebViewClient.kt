package com.maxplay.app

import android.content.Context
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import okhttp3.Request
import java.io.ByteArrayInputStream

// MaxPlay CORS-Free WebViewClient & HTTPS Local Asset Server
// ----------------------------------------------------------------------
// 1. Serves bundled assets/webapp/ files over a real HTTPS virtual origin
//    (https://appassets.androidplatform.net/) so Vite ES Modules,
//    Tailwind CSS, Firebase Auth/Firestore, and IndexedDB work
//    with 100% compatibility and 0 black screen issues.
// 2. Fast-paths all Firebase, Google APIs, and image/poster/font requests
//    directly through Chromium's native HTTP/2 & disk-cache pipeline for
//    instant poster loading and zero UI lag.
// 3. Intercepts /api/proxy?url=... and cross-origin HLS streams (.m3u8, .ts, .m4s)
//    with matched Referer/Origin and Access-Control-Allow-Origin: *.
class CorsFreeWebViewClient(private val context: Context) : WebViewClient() {

    companion object {
        const val VIRTUAL_ASSET_HOST = "appassets.androidplatform.net"
        const val VIRTUAL_ASSET_ORIGIN = "https://appassets.androidplatform.net"

        // Stores custom Referer/Origin headers discovered per stream host domain & root domain
        val hostRefererMap = java.util.concurrent.ConcurrentHashMap<String, String>()

        @Volatile
        var lastActiveReferer: String? = null

        fun registerStreamReferer(streamUrl: String, refererUrl: String) {
            if (refererUrl.isBlank()) return
            try {
                val host = android.net.Uri.parse(streamUrl).host?.lowercase() ?: return
                val root = extractRootDomain(host)
                lastActiveReferer = refererUrl
                hostRefererMap[host] = refererUrl
                if (root.isNotEmpty()) {
                    hostRefererMap[root] = refererUrl
                }
            } catch (_: Exception) {
            }
        }

        fun resolveRefererForHost(host: String, fallbackScheme: String = "https"): String {
            val cleanHost = host.lowercase()
            hostRefererMap[cleanHost]?.let { return it }
            val root = extractRootDomain(cleanHost)
            if (root.isNotEmpty()) {
                hostRefererMap[root]?.let { return it }
            }
            if (cleanHost.contains("sprintcdn") || cleanHost.contains("owphbf") ||
                cleanHost.contains("r66nv9ed") || cleanHost.contains("n1mwq") ||
                cleanHost.contains("byseraguci") || cleanHost.contains("bysedikamoum") ||
                cleanHost.contains("filemoon") || cleanHost.contains("f16px") ||
                cleanHost.contains("1azayf9w") || cleanHost.contains("8mhlloqo") ||
                cleanHost.contains("kerapoxy") || cleanHost.contains("moonmov")
            ) {
                return "https://byseraguci.com/"
            }
            if (cleanHost.contains("voe")) {
                return "https://voe.sx/"
            }
            return lastActiveReferer ?: "$fallbackScheme://$host/"
        }

        fun isKnownStreamCdnHost(host: String): Boolean {
            val cleanHost = host.lowercase()
            if (hostRefererMap.containsKey(cleanHost)) return true
            val root = extractRootDomain(cleanHost)
            if (root.isNotEmpty() && hostRefererMap.containsKey(root)) return true
            return cleanHost.contains("sprintcdn") ||
                cleanHost.contains("owphbf") ||
                cleanHost.contains("r66nv9ed") ||
                cleanHost.contains("n1mwq") ||
                cleanHost.contains("byseraguci") ||
                cleanHost.contains("bysedikamoum") ||
                cleanHost.contains("filemoon") ||
                cleanHost.contains("f16px") ||
                cleanHost.contains("1azayf9w") ||
                cleanHost.contains("8mhlloqo") ||
                cleanHost.contains("kerapoxy") ||
                cleanHost.contains("moonmov") ||
                cleanHost.contains("voe.") ||
                cleanHost.contains("streamwish") ||
                cleanHost.contains("hlswish") ||
                cleanHost.contains("vidhide")
        }

        private fun extractRootDomain(host: String): String {
            val parts = host.split(".")
            return if (parts.size >= 2) {
                parts.takeLast(2).joinToString(".")
            } else {
                host
            }
        }
    }

    override fun shouldInterceptRequest(
        view: WebView?,
        request: WebResourceRequest?
    ): WebResourceResponse? {
        val uri = request?.url ?: return super.shouldInterceptRequest(view, request)
        val host = (uri.host ?: "").lowercase()
        val path = (uri.path ?: "/").lowercase()
        val reqUrl = uri.toString()
        val method = request.method?.uppercase() ?: "GET"

        // 0. Serve Local Offline Vault Segments & Playlists (https://maxplay.local/offline-vault/{key}/...)
        //    AND Scanned Phone Local Videos (https://maxplay.local/device-video/{id})
        if (host == "maxplay.local") {
            if (method == "OPTIONS") {
                return WebResourceResponse(
                    "text/plain",
                    "UTF-8",
                    200,
                    "OK",
                    buildCorsHeaders("text/plain"),
                    ByteArrayInputStream(ByteArray(0))
                )
            }
            if (path.startsWith("/offline-vault/")) {
                val vaultResp = MaxPlayOfflineVault.interceptOfflineVaultRequest(context.applicationContext, reqUrl)
                if (vaultResp != null) {
                    return vaultResp
                }
            } else if (path.startsWith("/device-video/")) {
                val rangeHeader = request.requestHeaders?.get("Range") ?: request.requestHeaders?.get("range")
                val devResp = MaxPlayOfflineVault.interceptDeviceVideoRequest(context.applicationContext, reqUrl, rangeHeader)
                if (devResp != null) {
                    return devResp
                }
            } else if (path.startsWith("/device-video-thumb/")) {
                val thumbResp = MaxPlayOfflineVault.interceptDeviceVideoThumbRequest(context.applicationContext, reqUrl)
                if (thumbResp != null) {
                    return thumbResp
                }
            }
        }

        // 0.5 Native on-device /api/proxy?url=... handler (Zero CORS, Zero Cloud Roundtrip regardless of whether loaded from local asset host or live URL!)
        if (path == "/api/proxy") {
            if (method == "OPTIONS") {
                return WebResourceResponse(
                    "text/plain",
                    "UTF-8",
                    200,
                    "OK",
                    buildCorsHeaders("text/plain"),
                    ByteArrayInputStream(ByteArray(0))
                )
            }
            val targetUrl = uri.getQueryParameter("url")
            val explicitReferer = uri.getQueryParameter("referer")
            if (!targetUrl.isNullOrBlank()) {
                if (!explicitReferer.isNullOrBlank()) {
                    registerStreamReferer(targetUrl, explicitReferer)
                }
                return proxyExternalUrlWithOkHttp(targetUrl, request, explicitReferer)
            }
        }

        // 0.6 Unblock CORS OPTIONS preflight for Byse/Filemoon /api/videos/... endpoints
        if (path.startsWith("/api/videos/") && method == "OPTIONS") {
            return WebResourceResponse(
                "text/plain",
                "UTF-8",
                200,
                "OK",
                buildCorsHeaders("text/plain"),
                ByteArrayInputStream(ByteArray(0))
            )
        }

        // 1. Serve Local Bundled WebApp & Native Proxy on https://appassets.androidplatform.net
        if (host == VIRTUAL_ASSET_HOST) {
            if (method == "OPTIONS") {
                return WebResourceResponse(
                    "text/plain",
                    "UTF-8",
                    200,
                    "OK",
                    buildCorsHeaders("text/plain"),
                    ByteArrayInputStream(ByteArray(0))
                )
            }

            val rawPath = uri.path ?: "/"

            // 1a. If WebApp calls /api/extract-stream on VIRTUAL_ASSET_HOST, return clean JSON {"ok":false}
            //     instead of falling through to index.html so SmartStreamService immediately uses native/client fallback.
            if (rawPath.startsWith("/api/")) {
                val apiFallback = """{"ok":false,"error":"Local asset host has no cloud backend route"}""".toByteArray(Charsets.UTF_8)
                return WebResourceResponse(
                    "application/json",
                    "UTF-8",
                    200,
                    "OK",
                    buildCorsHeaders("application/json"),
                    ByteArrayInputStream(apiFallback)
                )
            }

            // 1b. Disable PWA sw.js inside native APK since assets are already 100% local in APK
            if (rawPath == "/sw.js") {
                val noopSw = "// Native Android APK Asset Loader active".toByteArray(Charsets.UTF_8)
                return WebResourceResponse(
                    "application/javascript",
                    "UTF-8",
                    200,
                    "OK",
                    buildCorsHeaders("application/javascript"),
                    ByteArrayInputStream(noopSw)
                )
            }

            // 1c. Serve static file from assets/webapp/...
            val cleanPath = if (rawPath == "/" || rawPath.isEmpty()) {
                "index.html"
            } else {
                rawPath.removePrefix("/")
            }

            return try {
                val inputStream = context.assets.open("webapp/$cleanPath")
                val mime = getAssetMimeType(cleanPath)
                WebResourceResponse(
                    mime,
                    "UTF-8",
                    200,
                    "OK",
                    buildCorsHeaders(mime),
                    inputStream
                )
            } catch (_: Exception) {
                // SPA Route fallback: if path has no file extension, serve webapp/index.html
                if (!cleanPath.substringAfterLast('/').contains('.')) {
                    try {
                        val indexStream = context.assets.open("webapp/index.html")
                        WebResourceResponse(
                            "text/html",
                            "UTF-8",
                            200,
                            "OK",
                            buildCorsHeaders("text/html"),
                            indexStream
                        )
                    } catch (_: Exception) {
                        null
                    }
                } else {
                    null
                }
            }
        }

        // 2. PRIORITY HLS & STREAM CDN INTERCEPTION (Runs BEFORE static image/font fast-path bypass
        //    so disguised HLS segments ending in .jpg, .png, .webp, .ico, .woff2, .html, .txt on
        //    SprintCDN / Byse / Filemoon / Voe are NEVER skipped!)
        val lower = reqUrl.lowercase()
        val isHlsOrSegment =
            lower.contains(".m3u8") ||
                path.endsWith(".ts") ||
                path.endsWith(".m4s") ||
                lower.contains("/hls2/") ||
                lower.contains("master.txt") ||
                lower.contains("urlset") ||
                isKnownStreamCdnHost(host)

        if (isHlsOrSegment && (lower.startsWith("http://") || lower.startsWith("https://"))) {
            if (method == "OPTIONS") {
                return WebResourceResponse(
                    "text/plain",
                    "UTF-8",
                    200,
                    "OK",
                    buildCorsHeaders("text/plain"),
                    ByteArrayInputStream(ByteArray(0))
                )
            }
            if (method == "GET" || method == "HEAD") {
                val proxied = proxyExternalUrlWithOkHttp(reqUrl, request)
                if (proxied != null) return proxied
            }
        }

        // 3. FAST-PATH BYPASS: Never intercept Firebase, Google APIs, or normal Images/Posters/Fonts!
        //    Letting Chromium's native C++ HTTP/2 engine & disk cache handle these directly
        //    eliminates worker-thread bottlenecks and makes posters & Firestore data load instantly.
        if (host == "127.0.0.1" ||
            host == "localhost" ||
            host.contains("googleapis.com") ||
            host.contains("firebaseio.com") ||
            host.contains("firebaseapp.com") ||
            host.contains("gstatic.com") ||
            host.contains("google.com") ||
            host.contains("googleusercontent.com") ||
            host.contains("tmdb.org") ||
            host.contains("imgur.com") ||
            host.contains("ibb.co") ||
            host.contains("postimg.cc") ||
            host.contains("cloudinary.com") ||
            path.endsWith(".jpg") ||
            path.endsWith(".jpeg") ||
            path.endsWith(".png") ||
            path.endsWith(".webp") ||
            path.endsWith(".avif") ||
            path.endsWith(".gif") ||
            path.endsWith(".svg") ||
            path.endsWith(".ico") ||
            path.endsWith(".woff") ||
            path.endsWith(".woff2") ||
            path.endsWith(".ttf")
        ) {
            return null
        }

        return null
    }

    private fun resolveHlsRelativeUrl(baseUrl: String, relativeOrAbs: String): String {
        val trimmed = relativeOrAbs.trim()
        if (trimmed.startsWith("http://", ignoreCase = true) || trimmed.startsWith("https://", ignoreCase = true)) {
            return trimmed
        }
        return try {
            java.net.URL(java.net.URL(baseUrl), trimmed).toString()
        } catch (_: Exception) {
            trimmed
        }
    }

    private fun buildLocalProxyUrl(targetUrl: String, referer: String): String {
        val encUrl = java.net.URLEncoder.encode(targetUrl, "UTF-8")
        val encRef = java.net.URLEncoder.encode(referer, "UTF-8")
        return "$VIRTUAL_ASSET_ORIGIN/api/proxy?url=$encUrl&referer=$encRef"
    }

    private fun rewriteM3u8ManifestForLocalProxy(
        manifestText: String,
        baseUrl: String,
        customReferer: String
    ): String {
        val uriAttrRegex = Regex("""URI="([^"]+)"""")
        val lines = manifestText.lines()
        val sb = StringBuilder(manifestText.length + 1024)

        for (i in lines.indices) {
            val rawLine = lines[i]
            val trimmed = rawLine.trim()
            if (trimmed.isEmpty()) {
                sb.append("\n")
                continue
            }

            if (trimmed.startsWith("#")) {
                val rewrittenTag = if (trimmed.contains("URI=\"")) {
                    uriAttrRegex.replace(trimmed) { matchResult ->
                        val innerUri = matchResult.groupValues[1]
                        if (innerUri.isBlank() ||
                            innerUri.startsWith("data:", ignoreCase = true) ||
                            innerUri.contains("/api/proxy?url=") ||
                            innerUri.contains("maxplay.local")
                        ) {
                            matchResult.value
                        } else {
                            val resolved = resolveHlsRelativeUrl(baseUrl, innerUri)
                            registerStreamReferer(resolved, customReferer)
                            "URI=\"${buildLocalProxyUrl(resolved, customReferer)}\""
                        }
                    }
                } else {
                    trimmed
                }
                sb.append(rewrittenTag).append("\n")
            } else {
                if (trimmed.contains("/api/proxy?url=") || trimmed.contains("maxplay.local")) {
                    sb.append(trimmed).append("\n")
                } else {
                    val resolved = resolveHlsRelativeUrl(baseUrl, trimmed)
                    registerStreamReferer(resolved, customReferer)
                    sb.append(buildLocalProxyUrl(resolved, customReferer)).append("\n")
                }
            }
        }
        return sb.toString()
    }

    private fun proxyExternalUrlWithOkHttp(
        targetUrl: String,
        request: WebResourceRequest,
        explicitReferer: String? = null
    ): WebResourceResponse? {
        return try {
            val parsedTarget = android.net.Uri.parse(targetUrl)
            val host = parsedTarget.host ?: ""
            val scheme = parsedTarget.scheme ?: "https"
            val customReferer = if (!explicitReferer.isNullOrBlank()) {
                explicitReferer
            } else {
                resolveRefererForHost(host, scheme)
            }
            registerStreamReferer(targetUrl, customReferer)

            val customOrigin = try {
                val refUri = android.net.Uri.parse(customReferer)
                "${refUri.scheme ?: "https"}://${refUri.host ?: host}"
            } catch (_: Exception) {
                "$scheme://$host"
            }

            val lowerUrl = targetUrl.lowercase()
            val isLikelyPlaylist =
                lowerUrl.contains(".m3u8") ||
                    lowerUrl.contains("master.txt") ||
                    lowerUrl.contains("urlset")

            val okReqBuilder = Request.Builder()
                .url(targetUrl)
                .header("User-Agent", InbuiltStreamScraper.DEFAULT_USER_AGENT)
                .header("Accept", "*/*")
                .header("Referer", customReferer)
                .header("Origin", customOrigin)

            if (!isLikelyPlaylist) {
                // Prevent transparent gzip on binary segments so Content-Length & byte ranges stay 1:1
                okReqBuilder.header("Accept-Encoding", "identity")
            }

            val rangeHdr = request.requestHeaders?.get("Range") ?: request.requestHeaders?.get("range")
            if (!rangeHdr.isNullOrBlank()) {
                okReqBuilder.header("Range", rangeHdr)
            }

            val response = InbuiltStreamScraper.okHttpClient.newCall(okReqBuilder.build()).execute()
            val statusCode = response.code
            val finalResolvedUrl = response.request.url.toString()
            registerStreamReferer(finalResolvedUrl, customReferer)

            val contentTypeRaw = response.header("Content-Type") ?: guessMediaMimeType(lowerUrl)
            var mimeType = contentTypeRaw.substringBefore(";").trim().ifEmpty { "application/octet-stream" }

            val isPlaylistResponse =
                isLikelyPlaylist ||
                    mimeType.contains("mpegurl", ignoreCase = true) ||
                    mimeType.contains("x-mpegurl", ignoreCase = true)

            if (isPlaylistResponse && response.isSuccessful) {
                val bodyText = response.body?.string() ?: ""
                if (bodyText.trimStart().startsWith("#EXTM3U")) {
                    val rewrittenText = rewriteM3u8ManifestForLocalProxy(bodyText, finalResolvedUrl, customReferer)
                    val outBytes = rewrittenText.toByteArray(Charsets.UTF_8)
                    val outMime = "application/vnd.apple.mpegurl"
                    val headers = buildCorsHeaders(outMime).toMutableMap()
                    headers["Content-Length"] = outBytes.size.toString()
                    headers["Cache-Control"] = "no-store"
                    return WebResourceResponse(
                        outMime,
                        "UTF-8",
                        statusCode,
                        response.message.ifEmpty { "OK" },
                        headers,
                        ByteArrayInputStream(outBytes)
                    )
                } else {
                    val rawBytes = bodyText.toByteArray(Charsets.UTF_8)
                    val headers = buildCorsHeaders(mimeType).toMutableMap()
                    headers["Content-Length"] = rawBytes.size.toString()
                    return WebResourceResponse(
                        mimeType,
                        "UTF-8",
                        statusCode,
                        response.message.ifEmpty { "OK" },
                        headers,
                        ByteArrayInputStream(rawBytes)
                    )
                }
            }

            // For disguised segments (.jpg, .png, .webp, .html, .txt) on HLS CDNs, normalize MIME type to video/mp2t
            // so hls.js / MSE never rejects segment buffers due to image/* Content-Type headers.
            if (lowerUrl.contains("/hls2/") || isKnownStreamCdnHost(host)) {
                if (mimeType.startsWith("image/") || mimeType.startsWith("text/html")) {
                    mimeType = "video/mp2t"
                }
            }

            val responseHeaders = buildCorsHeaders(mimeType).toMutableMap()
            response.header("Content-Length")?.let { responseHeaders["Content-Length"] = it }
            response.header("Content-Range")?.let { responseHeaders["Content-Range"] = it }
            response.header("Accept-Ranges")?.let { responseHeaders["Accept-Ranges"] = it }

            val bodyStream = response.body?.byteStream() ?: ByteArrayInputStream(ByteArray(0))

            WebResourceResponse(
                mimeType,
                null,
                statusCode,
                response.message.ifEmpty { "OK" },
                responseHeaders,
                bodyStream
            )
        } catch (_: Exception) {
            null
        }
    }

    private fun getAssetMimeType(filePath: String): String {
        val ext = filePath.substringAfterLast('.', "").lowercase()
        return when (ext) {
            "html", "htm" -> "text/html"
            "js", "mjs" -> "application/javascript"
            "css" -> "text/css"
            "json", "map" -> "application/json"
            "svg" -> "image/svg+xml"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "webp" -> "image/webp"
            "gif" -> "image/gif"
            "ico" -> "image/x-icon"
            "woff" -> "font/woff"
            "woff2" -> "font/woff2"
            "ttf" -> "font/ttf"
            "mp4" -> "video/mp4"
            "webm" -> "video/webm"
            else -> "application/octet-stream"
        }
    }

    private fun guessMediaMimeType(lowerUrl: String): String {
        return when {
            lowerUrl.contains(".m3u8") -> "application/vnd.apple.mpegurl"
            lowerUrl.contains(".ts") -> "video/mp2t"
            lowerUrl.contains(".m4s") || lowerUrl.contains(".mp4") -> "video/mp4"
            else -> "application/octet-stream"
        }
    }

    private fun buildCorsHeaders(contentType: String): Map<String, String> {
        return mapOf(
            "Access-Control-Allow-Origin" to "*",
            "Access-Control-Allow-Methods" to "GET, POST, OPTIONS, HEAD",
            "Access-Control-Allow-Headers" to "Content-Type, Accept, Range, Authorization, X-Captcha-Token, X-Embed-Origin, X-Embed-Referer, X-Embed-Parent, *",
            "Access-Control-Expose-Headers" to "Content-Length, Content-Range, Accept-Ranges",
            "Access-Control-Max-Age" to "86400",
            "Content-Type" to contentType
        )
    }
}
