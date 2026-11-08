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
                cleanHost.contains("voe") ||
                cleanHost.contains("upnshare") ||
                cleanHost.contains("streamwish") ||
                cleanHost.contains("hlswish") ||
                cleanHost.contains("playerwish") ||
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

        // 0.5 Native on-device /api/proxy, /proxy/m3u8, /api/stream-proxy, /proxy/ts handler (Zero CORS, Zero Cloud Roundtrip)
        if (
            path == "/api/proxy" ||
            path == "/proxy/m3u8" ||
            path == "/api/proxy/m3u8" ||
            path == "/api/stream-proxy" ||
            path == "/proxy/ts" ||
            path == "/api/proxy/ts"
        ) {
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
                path.endsWith(".aac") ||
                lower.contains("/hls2/") ||
                lower.contains("/hls/") ||
                lower.contains("master.txt") ||
                lower.contains("urlset") ||
                Regex("""/(?:seg|frag|chunk|part|slice)-\d+""").containsMatchIn(lower) ||
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
            val pathOnly = (parsedTarget.path ?: "").lowercase()
            // IMPORTANT: Never check lowerUrl.contains("urlset") here because VOE & Filemoon .ts segments
            // reside inside a "...,.urlset/seg-1-v1-a1.ts" parent folder!
            val isLikelyPlaylist =
                pathOnly.endsWith(".m3u8") ||
                    pathOnly.endsWith("master.txt") ||
                    lowerUrl.contains(".m3u8?")

            val okReqBuilder = Request.Builder()
                .url(targetUrl)
                .header("User-Agent", InbuiltStreamScraper.DEFAULT_USER_AGENT)
                .header("Accept", "*/*")
                .header("Referer", customReferer)
                .header("Origin", customOrigin)

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

            if (isLikelyPlaylist) {
                mimeType = "application/vnd.apple.mpegurl"
            } else if (lowerUrl.contains("/hls2/") || lowerUrl.contains("/hls/") || isKnownStreamCdnHost(host)) {
                // Normalize disguised segment MIME types (.jpg, .png, .webp, .html, .txt) so hls.js / MSE never rejects segment buffers
                if (mimeType.startsWith("image/") || mimeType.startsWith("text/html") || mimeType.startsWith("text/plain")) {
                    mimeType = "video/mp2t"
                }
            }

            val responseHeaders = buildCorsHeaders(mimeType).toMutableMap()
            response.header("Content-Length")?.let { responseHeaders["Content-Length"] = it }
            response.header("Content-Range")?.let { responseHeaders["Content-Range"] = it }
            response.header("Accept-Ranges")?.let { responseHeaders["Accept-Ranges"] = it }

            val bodyStream = response.body?.byteStream() ?: ByteArrayInputStream(ByteArray(0))
            val encoding = if (isLikelyPlaylist) "UTF-8" else null

            WebResourceResponse(
                mimeType,
                encoding,
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
            "Access-Control-Allow-Headers" to "*",
            "Access-Control-Expose-Headers" to "Content-Length, Content-Range, Accept-Ranges",
            "Access-Control-Max-Age" to "86400",
            "Content-Type" to contentType
        )
    }
}
