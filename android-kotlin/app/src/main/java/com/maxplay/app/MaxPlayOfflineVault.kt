package com.maxplay.app

import android.content.Context
import android.os.StatFs
import android.webkit.WebResourceResponse
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.util.concurrent.TimeUnit

/**
 * Native Disk Storage Engine for MaxPlay Offline Downloads.
 *
 * Saves HLS video segments (.ts / .m4s) and MP4 files directly into Android's private
 * internal storage (context.filesDir/maxplay_offline_vault/{safeKey}/) instead of
 * holding hundreds of megabytes in WebView RAM / IndexedDB Blobs.
 *
 * Supports:
 * 1. Direct native OkHttp segment downloading to disk with automatic retry.
 * 2. Segment checkpoint tracking (pause/resume from exact segment index even after app restart).
 * 3. Virtual local HLS server via shouldInterceptRequest:
 *    - https://maxplay.local/offline-vault/{safeKey}/index.m3u8
 *    - https://maxplay.local/offline-vault/{safeKey}/seg_{index}.ts
 *    - https://maxplay.local/offline-vault/{safeKey}/direct.mp4
 * 4. Real device storage statistics via Android StatFs.
 */
object MaxPlayOfflineVault {

    private const val VAULT_DIR_NAME = "maxplay_offline_vault"

    private val downloadHttpClient: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .dispatcher(okhttp3.Dispatcher().apply {
                maxRequests = 64
                maxRequestsPerHost = 32
            })
            .connectionPool(okhttp3.ConnectionPool(32, 5, TimeUnit.MINUTES))
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(45, TimeUnit.SECONDS)
            .followRedirects(true)
            .followSslRedirects(true)
            .retryOnConnectionFailure(true)
            .build()
    }

    private fun getVaultRoot(context: Context): File {
        val dir = File(context.filesDir, VAULT_DIR_NAME)
        if (!dir.exists()) {
            dir.mkdirs()
        }
        return dir
    }

    fun sanitizeKey(storageKey: String): String {
        return storageKey.replace(Regex("[^a-zA-Z0-9._-]"), "_")
    }

    fun getItemDir(context: Context, storageKey: String): File {
        val safe = sanitizeKey(storageKey)
        val dir = File(getVaultRoot(context), safe)
        if (!dir.exists()) {
            dir.mkdirs()
        }
        return dir
    }

    /**
     * Downloads a single HLS segment (video or audio) or MP4 chunk directly to internal storage via OkHttp.
     * If the segment already exists on disk and has > 512 bytes, returns its size immediately (0ms checkpoint resume).
     */
    fun downloadSegmentToDisk(
        context: Context,
        storageKey: String,
        segmentIndex: Int,
        segmentUrl: String,
        refererUrl: String = "",
        isAudio: Boolean = false
    ): JSONObject {
        val res = JSONObject()
        try {
            val itemDir = getItemDir(context, storageKey)
            val prefix = if (isAudio) "aud_" else "seg_"
            val segFile = File(itemDir, "${prefix}${segmentIndex}.ts")

            // Checkpoint Resume: If segment was already downloaded in an earlier session, reuse it!
            if (segFile.exists() && segFile.length() > 512L) {
                res.put("ok", true)
                res.put("bytes", segFile.length())
                res.put("cached", true)
                return res
            }

            val reqBuilder = Request.Builder()
                .url(segmentUrl)
                .header(
                    "User-Agent",
                    InbuiltStreamScraper.DEFAULT_USER_AGENT
                )
                .header("Accept", "*/*")

            val resolvedRef = if (refererUrl.isNotBlank()) {
                refererUrl
            } else {
                val segHost = try { android.net.Uri.parse(segmentUrl).host ?: "" } catch (_: Exception) { "" }
                CorsFreeWebViewClient.resolveRefererForHost(segHost)
            }

            if (resolvedRef.isNotBlank()) {
                reqBuilder.header("Referer", resolvedRef)
                try {
                    val refUri = android.net.Uri.parse(resolvedRef)
                    val refOrigin = "${refUri.scheme}://${refUri.host}"
                    if (!refUri.host.isNullOrBlank()) {
                        reqBuilder.header("Origin", refOrigin)
                    }
                } catch (_: Exception) {}
            }

            downloadHttpClient.newCall(reqBuilder.build()).execute().use { response ->
                if (!response.isSuccessful) {
                    res.put("ok", false)
                    res.put("error", "HTTP ${response.code}")
                    return res
                }

                val body = response.body
                if (body == null) {
                    res.put("ok", false)
                    res.put("error", "Empty response body")
                    return res
                }

                val tmpFile = File(itemDir, "${prefix}${segmentIndex}.tmp")
                body.byteStream().use { input ->
                    FileOutputStream(tmpFile).use { output ->
                        val buffer = ByteArray(32 * 1024)
                        var read: Int
                        while (input.read(buffer).also { read = it } != -1) {
                            output.write(buffer, 0, read)
                        }
                        output.flush()
                    }
                }

                if (tmpFile.exists() && tmpFile.length() > 0L) {
                    if (segFile.exists()) segFile.delete()
                    tmpFile.renameTo(segFile)
                    res.put("ok", true)
                    res.put("bytes", segFile.length())
                    res.put("cached", false)
                    return res
                } else {
                    tmpFile.delete()
                    res.put("ok", false)
                    res.put("error", "Zero bytes written")
                    return res
                }
            }
        } catch (e: Exception) {
            res.put("ok", false)
            res.put("error", e.message ?: "Disk segment download failed")
            return res
        }
    }

    /**
     * Writes metadata for a completed or in-progress HLS download so that we can generate
     * a valid local HLS playlist (index.m3u8, plus video.m3u8 & audio.m3u8 when separate audio track exists).
     */
    fun saveDownloadManifest(
        context: Context,
        storageKey: String,
        totalSegments: Int,
        totalDurationSec: Double,
        isSingleFile: Boolean = false,
        totalAudioSegments: Int = 0,
        languageLabel: String = "Default"
    ): Boolean {
        return try {
            val itemDir = getItemDir(context, storageKey)
            val metaFile = File(itemDir, "manifest.json")
            val json = JSONObject().apply {
                put("storageKey", storageKey)
                put("totalSegments", totalSegments)
                put("totalAudioSegments", totalAudioSegments)
                put("languageLabel", languageLabel)
                put("totalDurationSec", totalDurationSec)
                put("isSingleFile", isSingleFile)
                put("updatedAt", System.currentTimeMillis())
            }
            metaFile.writeText(json.toString())

            // Pre-generate local m3u8 playlist(s) on disk for instant playback
            generateLocalM3u8File(itemDir, totalSegments, totalDurationSec, totalAudioSegments, languageLabel)
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun generateLocalM3u8File(
        itemDir: File,
        totalSegments: Int,
        totalDurationSec: Double,
        totalAudioSegments: Int = 0,
        languageLabel: String = "Default"
    ) {
        if (totalSegments <= 0) return
        val avgSegDur = if (totalDurationSec > 0 && totalSegments > 0) {
            (totalDurationSec / totalSegments).coerceIn(1.5, 12.0)
        } else {
            4.0
        }
        val targetDur = kotlin.math.ceil(avgSegDur + 2.0).toInt().coerceAtLeast(6)
        val segDurFormatted = String.format(java.util.Locale.US, "%.3f", avgSegDur)

        val videoSb = StringBuilder()
        videoSb.appendLine("#EXTM3U")
        videoSb.appendLine("#EXT-X-VERSION:3")
        videoSb.appendLine("#EXT-X-TARGETDURATION:$targetDur")
        videoSb.appendLine("#EXT-X-MEDIA-SEQUENCE:0")
        videoSb.appendLine("#EXT-X-PLAYLIST-TYPE:VOD")

        for (i in 0 until totalSegments) {
            val segFile = File(itemDir, "seg_${i}.ts")
            if (segFile.exists() && segFile.length() > 0L) {
                videoSb.appendLine("#EXTINF:$segDurFormatted,")
                videoSb.appendLine("seg_${i}.ts")
            }
        }
        videoSb.appendLine("#EXT-X-ENDLIST")

        // Check if separate audio segments exist on disk
        val hasAudioSegments = totalAudioSegments > 0 && File(itemDir, "aud_0.ts").exists()
        if (hasAudioSegments) {
            // Write video.m3u8
            File(itemDir, "video.m3u8").writeText(videoSb.toString())

            // Write audio.m3u8
            val avgAudDur = if (totalDurationSec > 0 && totalAudioSegments > 0) {
                (totalDurationSec / totalAudioSegments).coerceIn(1.5, 12.0)
            } else {
                avgSegDur
            }
            val audTargetDur = kotlin.math.ceil(avgAudDur + 2.0).toInt().coerceAtLeast(6)
            val audDurFormatted = String.format(java.util.Locale.US, "%.3f", avgAudDur)

            val audioSb = StringBuilder()
            audioSb.appendLine("#EXTM3U")
            audioSb.appendLine("#EXT-X-VERSION:3")
            audioSb.appendLine("#EXT-X-TARGETDURATION:$audTargetDur")
            audioSb.appendLine("#EXT-X-MEDIA-SEQUENCE:0")
            audioSb.appendLine("#EXT-X-PLAYLIST-TYPE:VOD")

            for (i in 0 until totalAudioSegments) {
                val audFile = File(itemDir, "aud_${i}.ts")
                if (audFile.exists() && audFile.length() > 0L) {
                    audioSb.appendLine("#EXTINF:$audDurFormatted,")
                    audioSb.appendLine("aud_${i}.ts")
                }
            }
            audioSb.appendLine("#EXT-X-ENDLIST")
            File(itemDir, "audio.m3u8").writeText(audioSb.toString())

            // Write Master index.m3u8 binding video.m3u8 + audio.m3u8
            val safeLangName = languageLabel.replace("\"", "").ifBlank { "Selected Audio" }
            val masterSb = StringBuilder()
            masterSb.appendLine("#EXTM3U")
            masterSb.appendLine("#EXT-X-VERSION:3")
            masterSb.appendLine("#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"offline_audio\",NAME=\"$safeLangName\",LANGUAGE=\"$safeLangName\",DEFAULT=YES,AUTOSELECT=YES,URI=\"audio.m3u8\"")
            masterSb.appendLine("#EXT-X-STREAM-INF:BANDWIDTH=2000000,AUDIO=\"offline_audio\"")
            masterSb.appendLine("video.m3u8")
            File(itemDir, "index.m3u8").writeText(masterSb.toString())
        } else {
            // Single muxed stream: index.m3u8 is the media playlist directly
            File(itemDir, "index.m3u8").writeText(videoSb.toString())
        }
    }

    /**
     * Returns checkpoint status for a storageKey (how many video & audio segments exist on disk and total bytes).
     */
    fun getCheckpointInfo(context: Context, storageKey: String): JSONObject {
        val json = JSONObject()
        try {
            val safe = sanitizeKey(storageKey)
            val itemDir = File(getVaultRoot(context), safe)
            if (!itemDir.exists()) {
                json.put("exists", false)
                json.put("downloadedSegments", 0)
                json.put("totalBytes", 0L)
                return json
            }

            var count = 0
            var bytes = 0L
            val videoIdxList = mutableListOf<Int>()
            val audioIdxList = mutableListOf<Int>()
            val files = itemDir.listFiles() ?: emptyArray()
            for (f in files) {
                if (f.name.startsWith("seg_") && f.name.endsWith(".ts") && f.length() > 512L) {
                    count++
                    bytes += f.length()
                    val idxStr = f.name.removePrefix("seg_").removeSuffix(".ts")
                    idxStr.toIntOrNull()?.let { videoIdxList.add(it) }
                } else if (f.name.startsWith("aud_") && f.name.endsWith(".ts") && f.length() > 512L) {
                    bytes += f.length()
                    val idxStr = f.name.removePrefix("aud_").removeSuffix(".ts")
                    idxStr.toIntOrNull()?.let { audioIdxList.add(it) }
                }
            }

            videoIdxList.sort()
            audioIdxList.sort()
            val completedIndices = JSONArray()
            videoIdxList.forEach { completedIndices.put(it) }
            val completedAudioIndices = JSONArray()
            audioIdxList.forEach { completedAudioIndices.put(it) }

            val directMp4 = File(itemDir, "direct.mp4")
            if (directMp4.exists() && directMp4.length() > 512L) {
                if (count == 0) {
                    count = 1
                    bytes = directMp4.length()
                    completedIndices.put(0)
                }
            }

            json.put("exists", count > 0)
            json.put("downloadedSegments", count)
            json.put("totalBytes", bytes)
            json.put("completedIndices", completedIndices)
            json.put("completedAudioIndices", completedAudioIndices)
            json.put("playbackUrl", getLocalPlaybackUrl(storageKey, context))
        } catch (e: Exception) {
            json.put("exists", false)
            json.put("error", e.message ?: "Error")
        }
        return json
    }

    /**
     * Packages an offline item's segments directly on disk into a `.maxplay` container file with zero RAM overhead.
     */
    fun exportOfflineItemToMaxPlayFile(
        context: Context,
        storageKey: String,
        fileName: String,
        metadataJson: String
    ): File? {
        return try {
            val safe = sanitizeKey(storageKey)
            val itemDir = File(getVaultRoot(context), safe)
            if (!itemDir.exists()) return null

            val segFiles = (itemDir.listFiles { _, name ->
                name.startsWith("seg_") && name.endsWith(".ts")
            } ?: emptyArray()).filter { it.length() > 512L }.sortedBy {
                it.name.removePrefix("seg_").removeSuffix(".ts").toIntOrNull() ?: 0
            }

            if (segFiles.isEmpty()) return null

            val audFiles = (itemDir.listFiles { _, name ->
                name.startsWith("aud_") && name.endsWith(".ts")
            } ?: emptyArray()).filter { it.length() > 512L }.sortedBy {
                it.name.removePrefix("aud_").removeSuffix(".ts").toIntOrNull() ?: 0
            }

            val videoLengths = JSONArray()
            segFiles.forEach { videoLengths.put(it.length()) }
            val audioLengths = JSONArray()
            audFiles.forEach { audioLengths.put(it.length()) }

            val metadataObj = try {
                JSONObject(metadataJson)
            } catch (_: Exception) {
                JSONObject()
            }

            val headerObj = JSONObject().apply {
                put("magic", "MAXPLAY_CONTAINER_V1")
                put("exportedAt", System.currentTimeMillis())
                put("storageKey", storageKey)
                put("totalDurationSec", segFiles.size * 4)
                put("isSingleFile", segFiles.size == 1)
                put("videoSegmentLengths", videoLengths)
                put("audioSegmentLengths", audioLengths)
                put("metadata", metadataObj)
            }

            val headerBytes = headerObj.toString().toByteArray(Charsets.UTF_8)
            val magicBytes = "MAXPLAY1".toByteArray(Charsets.UTF_8)
            val hLen = headerBytes.size
            val lenBytes = byteArrayOf(
                ((hLen ushr 24) and 0xFF).toByte(),
                ((hLen ushr 16) and 0xFF).toByte(),
                ((hLen ushr 8) and 0xFF).toByte(),
                (hLen and 0xFF).toByte()
            )

            val cleanName = fileName.replace(Regex("[^a-zA-Z0-9._-]"), "_").let {
                if (it.endsWith(".maxplay")) it else "$it.maxplay"
            }
            val outDir = context.externalCacheDir ?: context.cacheDir
            val outFile = File(outDir, cleanName)
            if (outFile.exists()) outFile.delete()

            FileOutputStream(outFile).use { out ->
                out.write(magicBytes)
                out.write(lenBytes)
                out.write(headerBytes)
                val buf = ByteArray(64 * 1024)
                for (seg in segFiles) {
                    FileInputStream(seg).use { input ->
                        var r: Int
                        while (input.read(buf).also { r = it } != -1) {
                            out.write(buf, 0, r)
                        }
                    }
                }
                for (aud in audFiles) {
                    FileInputStream(aud).use { input ->
                        var r: Int
                        while (input.read(buf).also { r = it } != -1) {
                            out.write(buf, 0, r)
                        }
                    }
                }
                out.flush()
            }

            if (outFile.exists() && outFile.length() > 12L) outFile else null
        } catch (_: Exception) {
            null
        }
    }

    private fun isProgressiveVideoFile(file: File): Boolean {
        if (!file.exists() || file.length() < 16L) return false
        return try {
            val hdr = ByteArray(12)
            FileInputStream(file).use { it.read(hdr) }
            // Check MP4/MOV 'ftyp' at bytes 4..7 or MKV/WebM EBML 0x1A 0x45 0xDF 0xA3 at bytes 0..3
            val isMp4 = hdr[4] == 'f'.code.toByte() && hdr[5] == 't'.code.toByte() &&
                hdr[6] == 'y'.code.toByte() && hdr[7] == 'p'.code.toByte()
            val isMkvOrWebm = hdr[0] == 0x1A.toByte() && hdr[1] == 0x45.toByte() &&
                hdr[2] == 0xDF.toByte() && hdr[3] == 0xA3.toByte()
            isMp4 || isMkvOrWebm
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Returns the optimal playback URL for an offline item:
     * - If the item is a direct MP4/MKV/WebM video (e.g. received local phone video), serves it via the
     *   dedicated Local Loopback HTTP Range Server (`http://127.0.0.1:<port>/vault-video/{safe}/video.mp4`)
     *   so HTML5 `<video>` plays and seeks natively without feeding an MP4 container into `hls.js`.
     * - Otherwise returns the local HLS playlist URL (`https://maxplay.local/offline-vault/{safe}/index.m3u8`).
     */
    fun getLocalPlaybackUrl(storageKey: String, context: Context? = null): String {
        val safe = sanitizeKey(storageKey)
        if (context != null) {
            try {
                val itemDir = File(getVaultRoot(context), safe)
                val directMp4 = File(itemDir, "direct.mp4")
                val seg0 = File(itemDir, "seg_0.ts")
                if ((directMp4.exists() && directMp4.length() > 512L) || isProgressiveVideoFile(seg0)) {
                    val port = ensureLocalVideoHttpServer(context)
                    if (port > 0) {
                        return "http://127.0.0.1:$port/vault-video/$safe/video.mp4"
                    }
                    return "https://maxplay.local/offline-vault/$safe/direct.mp4"
                }
            } catch (_: Exception) {}
        }
        return "https://maxplay.local/offline-vault/$safe/index.m3u8"
    }

    /**
     * Checks if a downloaded item exists on native disk and is completely downloaded & playable.
     * Verifies manifest.json and segment count so interrupted partial transfers are never mistaken for complete items.
     */
    fun hasPlayableOfflineItem(context: Context, storageKey: String): Boolean {
        return try {
            val safe = sanitizeKey(storageKey)
            val itemDir = File(getVaultRoot(context), safe)
            if (!itemDir.exists()) return false
            val directMp4 = File(itemDir, "direct.mp4")
            if (directMp4.exists() && directMp4.length() > 512L) return true

            val seg0 = File(itemDir, "seg_0.ts")
            if (!seg0.exists() || seg0.length() <= 0L) return false

            val metaFile = File(itemDir, "manifest.json")
            if (!metaFile.exists()) return false

            val metaJson = JSONObject(metaFile.readText())
            val expectedSegs = metaJson.optInt("totalSegments", 0)
            if (expectedSegs <= 1) return true

            val actualSegs = (itemDir.listFiles { _, name ->
                name.startsWith("seg_") && name.endsWith(".ts")
            } ?: emptyArray()).count { it.length() > 0L }

            actualSegs >= (expectedSegs * 95) / 100
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Deletes all segments and metadata for a specific storageKey from native disk.
     */
    fun deleteOfflineItem(context: Context, storageKey: String): Boolean {
        return try {
            val safe = sanitizeKey(storageKey)
            val itemDir = File(getVaultRoot(context), safe)
            if (itemDir.exists()) {
                itemDir.deleteRecursively()
            }
            true
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Returns real Android internal storage statistics (total, free, and used by MaxPlay downloads).
     */
    fun getDeviceStorageStats(context: Context): JSONObject {
        val json = JSONObject()
        try {
            val stat = StatFs(context.filesDir.absolutePath)
            val totalBytes = stat.totalBytes
            val freeBytes = stat.availableBytes
            val usedByAppBytes = calculateDirectorySize(getVaultRoot(context))

            json.put("ok", true)
            json.put("totalBytes", totalBytes)
            json.put("freeBytes", freeBytes)
            json.put("usedByAppBytes", usedByAppBytes)
            json.put("totalGb", String.format(java.util.Locale.US, "%.1f", totalBytes / (1024.0 * 1024.0 * 1024.0)).toDouble())
            json.put("freeGb", String.format(java.util.Locale.US, "%.1f", freeBytes / (1024.0 * 1024.0 * 1024.0)).toDouble())
            json.put("usedByAppMb", String.format(java.util.Locale.US, "%.1f", usedByAppBytes / (1024.0 * 1024.0)).toDouble())
        } catch (e: Exception) {
            json.put("ok", false)
            json.put("error", e.message ?: "Failed to read storage")
        }
        return json
    }

    private fun calculateDirectorySize(dir: File): Long {
        if (!dir.exists()) return 0L
        var total = 0L
        val files = dir.listFiles() ?: return 0L
        for (f in files) {
            total += if (f.isDirectory) calculateDirectorySize(f) else f.length()
        }
        return total
    }

    /**
     * Serves virtual local requests to https://maxplay.local/offline-vault/{safeKey}/...
     * directly from Android internal storage with 0% RAM overhead.
     */
    fun interceptOfflineVaultRequest(context: Context, url: String): WebResourceResponse? {
        try {
            // Expected pattern: https://maxplay.local/offline-vault/{safeKey}/{fileName}
            val marker = "/offline-vault/"
            val idx = url.indexOf(marker)
            if (idx == -1) return null

            val subPath = url.substring(idx + marker.length).substringBefore("?")
            val parts = subPath.split("/")
            if (parts.size < 2) return null

            val safeKey = sanitizeKey(parts[0])
            val fileName = parts[1]
            val itemDir = File(getVaultRoot(context), safeKey)
            if (!itemDir.exists()) return null

            val corsHeaders = mapOf(
                "Access-Control-Allow-Origin" to "*",
                "Access-Control-Allow-Methods" to "GET, HEAD, OPTIONS",
                "Access-Control-Allow-Headers" to "*",
                "Cache-Control" to "no-cache"
            )

            if (fileName == "index.m3u8" || fileName == "video.m3u8" || fileName == "audio.m3u8") {
                val m3u8File = File(itemDir, fileName)
                if (!m3u8File.exists() && fileName == "index.m3u8") {
                    // Dynamically build index.m3u8 from whatever seg_*.ts and aud_*.ts files exist on disk
                    val segFiles = (itemDir.listFiles { _, name ->
                        name.startsWith("seg_") && name.endsWith(".ts")
                    } ?: emptyArray()).sortedBy {
                        it.name.removePrefix("seg_").removeSuffix(".ts").toIntOrNull() ?: 0
                    }
                    val audFiles = (itemDir.listFiles { _, name ->
                        name.startsWith("aud_") && name.endsWith(".ts")
                    } ?: emptyArray()).sortedBy {
                        it.name.removePrefix("aud_").removeSuffix(".ts").toIntOrNull() ?: 0
                    }

                    if (segFiles.isEmpty()) return null
                    generateLocalM3u8File(itemDir, segFiles.size, segFiles.size * 4.0, audFiles.size, "Selected Audio")
                }

                if (m3u8File.exists()) {
                    val bytes = m3u8File.readBytes()
                    return WebResourceResponse(
                        "application/vnd.apple.mpegurl",
                        "UTF-8",
                        200,
                        "OK",
                        corsHeaders,
                        ByteArrayInputStream(bytes)
                    )
                }
            } else if (fileName == "direct.mp4") {
                val directFile = File(itemDir, "direct.mp4").takeIf { it.exists() && it.length() > 0L }
                    ?: File(itemDir, "seg_0.ts").takeIf { it.exists() && it.length() > 0L }
                if (directFile != null) {
                    val fileHeaders = corsHeaders + mapOf(
                        "Content-Length" to directFile.length().toString(),
                        "Accept-Ranges" to "bytes"
                    )
                    return WebResourceResponse(
                        "video/mp4",
                        null,
                        200,
                        "OK",
                        fileHeaders,
                        FileInputStream(directFile)
                    )
                }
            } else if ((fileName.startsWith("seg_") || fileName.startsWith("aud_")) && fileName.endsWith(".ts")) {
                val segFile = File(itemDir, fileName)
                if (segFile.exists() && segFile.length() > 0L) {
                    val fileHeaders = corsHeaders + ("Content-Length" to segFile.length().toString())
                    return WebResourceResponse(
                        "video/mp2t",
                        null,
                        200,
                        "OK",
                        fileHeaders,
                        FileInputStream(segFile)
                    )
                }
            }
        } catch (_: Exception) {
        }
        return null
    }

    /**
     * Scans the user's Android device storage via MediaStore.Video.Media for all video files
     * so they can be listed automatically in Downloads > Local files and played directly in MaxPlay.
     */
    fun scanDeviceLocalVideos(context: Context): JSONObject {
        val out = JSONObject()
        val arr = JSONArray()
        try {
            val projection = arrayOf(
                android.provider.MediaStore.Video.Media._ID,
                android.provider.MediaStore.Video.Media.DISPLAY_NAME,
                android.provider.MediaStore.Video.Media.TITLE,
                android.provider.MediaStore.Video.Media.SIZE,
                android.provider.MediaStore.Video.Media.DURATION,
                android.provider.MediaStore.Video.Media.WIDTH,
                android.provider.MediaStore.Video.Media.HEIGHT,
                android.provider.MediaStore.Video.Media.MIME_TYPE,
                android.provider.MediaStore.Video.Media.BUCKET_DISPLAY_NAME,
                android.provider.MediaStore.Video.Media.DATE_MODIFIED
            )

            val sortOrder = "${android.provider.MediaStore.Video.Media.DATE_MODIFIED} DESC"
            val cursor = context.contentResolver.query(
                android.provider.MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
                projection,
                null,
                null,
                sortOrder
            )

            cursor?.use { c ->
                val idCol = c.getColumnIndexOrThrow(android.provider.MediaStore.Video.Media._ID)
                val nameCol = c.getColumnIndexOrThrow(android.provider.MediaStore.Video.Media.DISPLAY_NAME)
                val titleCol = c.getColumnIndexOrThrow(android.provider.MediaStore.Video.Media.TITLE)
                val sizeCol = c.getColumnIndexOrThrow(android.provider.MediaStore.Video.Media.SIZE)
                val durCol = c.getColumnIndexOrThrow(android.provider.MediaStore.Video.Media.DURATION)
                val wCol = c.getColumnIndexOrThrow(android.provider.MediaStore.Video.Media.WIDTH)
                val hCol = c.getColumnIndexOrThrow(android.provider.MediaStore.Video.Media.HEIGHT)
                val mimeCol = c.getColumnIndexOrThrow(android.provider.MediaStore.Video.Media.MIME_TYPE)
                val folderCol = c.getColumnIndexOrThrow(android.provider.MediaStore.Video.Media.BUCKET_DISPLAY_NAME)
                val dateCol = c.getColumnIndexOrThrow(android.provider.MediaStore.Video.Media.DATE_MODIFIED)

                var count = 0
                val supportedExts = setOf("mp4", "mkv", "webm", "mov", "m4v", "3gp")
                while (c.moveToNext() && count < 200) {
                    val id = c.getLong(idCol)
                    val sizeBytes = c.getLong(sizeCol)
                    if (sizeBytes < 64 * 1024L) continue // Ignore tiny/corrupt files

                    val displayName = c.getString(nameCol) ?: ""
                    val durMs = c.getLong(durCol)
                    val mime = (c.getString(mimeCol) ?: "video/mp4").lowercase()

                    // Filter strictly to supported playable video formats with valid duration (> 1s)
                    val ext = displayName.substringAfterLast('.', "").lowercase()
                    val isSupportedMime = mime.startsWith("video/") && (
                        mime.contains("mp4") || mime.contains("matroska") || mime.contains("x-matroska") ||
                        mime.contains("webm") || mime.contains("quicktime") || mime.contains("3gpp") || mime.contains("mpeg")
                    )
                    val isSupportedExt = ext.isEmpty() || supportedExts.contains(ext)
                    if (durMs < 1000L || (!isSupportedMime && !isSupportedExt)) continue

                    val rawTitle = c.getString(titleCol) ?: displayName
                    val cleanTitle = rawTitle.replace(Regex("\\.(mp4|mkv|webm|mov|m4v|avi|flv|3gp)$", RegexOption.IGNORE_CASE), "")
                        .ifBlank { "Video $id" }

                    val width = c.getInt(wCol)
                    val height = c.getInt(hCol)
                    val folder = c.getString(folderCol) ?: "Phone Storage"
                    val dateMod = c.getLong(dateCol)

                    val shortSide = kotlin.math.min(width, height).let { if (it > 0) it else height }
                    val resLabel = when {
                        shortSide >= 2000 || width >= 3800 -> "4K"
                        shortSide >= 1000 || height >= 1000 -> "1080p"
                        shortSide >= 700 || height >= 700 -> "720p"
                        shortSide >= 450 || height >= 450 -> "480p"
                        shortSide > 0 -> "${shortSide}p"
                        else -> "HD"
                    }

                    val sizeMb = String.format(java.util.Locale.US, "%.1f", sizeBytes / (1024.0 * 1024.0)).toDouble()

                    val isVertical = height > width && width > 0
                    val localPort = ensureLocalVideoHttpServer(context)
                    val playbackUrl = if (localPort > 0) {
                        "http://127.0.0.1:$localPort/device-video/$id"
                    } else {
                        "https://maxplay.local/device-video/$id"
                    }

                    val obj = JSONObject().apply {
                        put("id", id.toString())
                        put("title", cleanTitle)
                        put("folderName", folder)
                        put("sizeMb", sizeMb)
                        put("durationSec", (durMs / 1000L).toInt())
                        put("resolution", resLabel)
                        put("width", width)
                        put("height", height)
                        put("isVertical", isVertical)
                        put("mimeType", mime)
                        put("dateModified", dateMod)
                        put("playbackUrl", playbackUrl)
                        put("thumbnailUrl", "https://maxplay.local/device-video-thumb/$id")
                    }
                    arr.put(obj)
                    count++
                }
            }
            out.put("ok", true)
            out.put("videos", arr)
        } catch (e: Exception) {
            out.put("ok", false)
            out.put("videos", arr)
            out.put("error", e.message ?: "Scan failed")
        }
        return out
    }

    /**
     * Generates and serves a real video frame thumbnail for any local video (`https://maxplay.local/device-video-thumb/{id}`)
     * with disk caching so subsequent opens render in 0ms.
     */
    private val thumbDecodeLock = Any()

    fun interceptDeviceVideoThumbRequest(
        context: Context,
        url: String
    ): WebResourceResponse? {
        return try {
            val marker = "/device-video-thumb/"
            val idx = url.indexOf(marker)
            if (idx == -1) return null

            val idStr = url.substring(idx + marker.length).substringBefore("?").substringBefore("/").trim()
            val videoId = idStr.toLongOrNull() ?: return null

            val corsHeaders = mapOf(
                "Access-Control-Allow-Origin" to "*",
                "Access-Control-Allow-Methods" to "GET, HEAD, OPTIONS",
                "Access-Control-Allow-Headers" to "*",
                "Cache-Control" to "public, max-age=86400"
            )

            val thumbDir = File(context.cacheDir, "video_thumbs")
            if (!thumbDir.exists()) thumbDir.mkdirs()
            val cachedThumb = File(thumbDir, "thumb_$videoId.jpg")

            if (cachedThumb.exists() && cachedThumb.length() > 256L) {
                return WebResourceResponse(
                    "image/jpeg",
                    null,
                    200,
                    "OK",
                    corsHeaders,
                    FileInputStream(cachedThumb)
                )
            }

            val contentUri = android.content.ContentUris.withAppendedId(
                android.provider.MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
                videoId
            )

            var bitmap: android.graphics.Bitmap? = null

            synchronized(thumbDecodeLock) {
                if (cachedThumb.exists() && cachedThumb.length() > 256L) {
                    return WebResourceResponse(
                        "image/jpeg",
                        null,
                        200,
                        "OK",
                        corsHeaders,
                        FileInputStream(cachedThumb)
                    )
                }

                // 1. Fast Android 10+ (API 29+) MediaStore loadThumbnail
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                    try {
                        bitmap = context.contentResolver.loadThumbnail(
                            contentUri,
                            android.util.Size(640, 360),
                            null
                        )
                    } catch (_: Exception) {}
                }

                // 2. Fallback: MediaMetadataRetriever real frame extraction (serialized to prevent MediaCodec exhaustion)
                if (bitmap == null) {
                    val retriever = android.media.MediaMetadataRetriever()
                    try {
                        retriever.setDataSource(context, contentUri)
                        bitmap = retriever.getFrameAtTime(
                            1_500_000L,
                            android.media.MediaMetadataRetriever.OPTION_CLOSEST_SYNC
                        ) ?: retriever.getFrameAtTime()
                    } catch (_: Exception) {
                    } finally {
                        try { retriever.release() } catch (_: Exception) {}
                    }
                }
            }

            // 3. Fallback: Legacy MediaStore Video.Thumbnails
            if (bitmap == null) {
                try {
                    @Suppress("DEPRECATION")
                    bitmap = android.provider.MediaStore.Video.Thumbnails.getThumbnail(
                        context.contentResolver,
                        videoId,
                        android.provider.MediaStore.Video.Thumbnails.MINI_KIND,
                        null
                    )
                } catch (_: Exception) {}
            }

            val finalBitmap = bitmap
            if (finalBitmap != null) {
                val baos = java.io.ByteArrayOutputStream()
                finalBitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 84, baos)
                val bytes = baos.toByteArray()
                if (bytes.isNotEmpty()) {
                    try {
                        FileOutputStream(cachedThumb).use { it.write(bytes) }
                    } catch (_: Exception) {}
                    return WebResourceResponse(
                        "image/jpeg",
                        null,
                        200,
                        "OK",
                        corsHeaders,
                        ByteArrayInputStream(bytes)
                    )
                }
            }
            null
        } catch (_: Exception) {
            null
        }
    }

    // =========================================================================
    // PERSISTENT LOCAL LOOPBACK HTTP VIDEO SERVER (127.0.0.1) FOR ZERO-GLITCH SEEKING
    // =========================================================================
    @Volatile
    private var localVideoServerSocket: java.net.ServerSocket? = null
    @Volatile
    private var localVideoServerPort: Int = 0

    private fun queryMediaStoreVideoSize(context: Context, contentUri: android.net.Uri): Long {
        return try {
            context.contentResolver.query(
                contentUri,
                arrayOf(android.provider.MediaStore.Video.Media.SIZE),
                null,
                null,
                null
            )?.use { c ->
                if (c.moveToFirst()) c.getLong(0) else -1L
            } ?: -1L
        } catch (_: Exception) {
            -1L
        }
    }

    fun ensureLocalVideoHttpServer(context: Context): Int {
        val existing = localVideoServerSocket
        if (existing != null && !existing.isClosed && localVideoServerPort > 0) {
            return localVideoServerPort
        }
        synchronized(this) {
            val checkAgain = localVideoServerSocket
            if (checkAgain != null && !checkAgain.isClosed && localVideoServerPort > 0) {
                return localVideoServerPort
            }
            return try {
                val appCtx = context.applicationContext
                val server = java.net.ServerSocket(0, 128, java.net.InetAddress.getByName("127.0.0.1"))
                localVideoServerSocket = server
                localVideoServerPort = server.localPort
                InbuiltStreamScraper.backgroundExecutor.execute {
                    while (localVideoServerSocket == server && !server.isClosed) {
                        try {
                            val client = server.accept()
                            InbuiltStreamScraper.backgroundExecutor.execute {
                                handleLocalVideoHttpSocket(appCtx, client)
                            }
                        } catch (_: Exception) {
                            break
                        }
                    }
                }
                localVideoServerPort
            } catch (_: Exception) {
                0
            }
        }
    }

    private fun handleLocalVideoHttpSocket(context: Context, socket: java.net.Socket) {
        socket.use { s ->
            try {
                s.soTimeout = 30000
                s.tcpNoDelay = true
                s.sendBufferSize = 1024 * 1024
                val reader = java.io.BufferedReader(java.io.InputStreamReader(s.getInputStream()))
                val requestLine = reader.readLine() ?: return
                val parts = requestLine.split(" ")
                if (parts.size < 2) return
                val method = parts[0].uppercase()
                val reqPath = parts[1].substringBefore("?")

                var rangeHeader: String? = null
                while (true) {
                    val line = reader.readLine()
                    if (line.isNullOrEmpty()) break
                    if (line.startsWith("Range:", ignoreCase = true)) {
                        rangeHeader = line.substringAfter(":").trim()
                    }
                }

                val outStream = java.io.BufferedOutputStream(s.getOutputStream(), 256 * 1024)
                if (method == "OPTIONS") {
                    val headers = "HTTP/1.1 200 OK\r\n" +
                        "Access-Control-Allow-Origin: *\r\n" +
                        "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n" +
                        "Access-Control-Allow-Headers: Range, Content-Type, Accept, Origin\r\n" +
                        "Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges\r\n" +
                        "Accept-Ranges: bytes\r\n" +
                        "Content-Length: 0\r\n" +
                        "Connection: close\r\n\r\n"
                    outStream.write(headers.toByteArray(Charsets.UTF_8))
                    outStream.flush()
                    return
                }

                // Route 1: /device-video/{id}
                if (reqPath.startsWith("/device-video/")) {
                    val idStr = reqPath.removePrefix("/device-video/").substringBefore("/").trim()
                    val videoId = idStr.toLongOrNull() ?: return
                    val contentUri = android.content.ContentUris.withAppendedId(
                        android.provider.MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
                        videoId
                    )
                    val rawMime = (context.contentResolver.getType(contentUri) ?: "video/mp4").lowercase()
                    val mimeType = when {
                        rawMime.contains("webm") -> "video/webm"
                        rawMime.contains("ogg") -> "video/ogg"
                        else -> "video/mp4"
                    }

                    val pfd = context.contentResolver.openFileDescriptor(contentUri, "r")
                    if (pfd == null) {
                        outStream.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
                        outStream.flush()
                        return
                    }

                    pfd.use { descriptor ->
                        val statLen = descriptor.statSize
                        val totalLength = if (statLen > 0L) statLen else queryMediaStoreVideoSize(context, contentUri)
                        val fis = FileInputStream(descriptor.fileDescriptor)
                        streamByteRangeOverSocket(
                            method = method,
                            mimeType = mimeType,
                            totalLength = totalLength,
                            rangeHeader = rangeHeader,
                            fileDescriptor = descriptor.fileDescriptor,
                            fis = fis,
                            outStream = outStream
                        )
                    }
                    return
                }

                // Route 2: /vault-video/{safeKey}/video.mp4
                if (reqPath.startsWith("/vault-video/")) {
                    val safeKey = reqPath.removePrefix("/vault-video/").substringBefore("/").trim()
                    val itemDir = File(getVaultRoot(context), sanitizeKey(safeKey))
                    val targetFile = File(itemDir, "direct.mp4").takeIf { it.exists() && it.length() > 0L }
                        ?: File(itemDir, "seg_0.ts").takeIf { it.exists() && it.length() > 0L }

                    if (targetFile == null) {
                        outStream.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
                        outStream.flush()
                        return
                    }

                    FileInputStream(targetFile).use { fis ->
                        streamByteRangeOverSocket(
                            method = method,
                            mimeType = "video/mp4",
                            totalLength = targetFile.length(),
                            rangeHeader = rangeHeader,
                            fileDescriptor = fis.fd,
                            fis = fis,
                            outStream = outStream
                        )
                    }
                    return
                }

                outStream.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
                outStream.flush()
            } catch (_: Exception) {}
        }
    }

    private fun streamByteRangeOverSocket(
        method: String,
        mimeType: String,
        totalLength: Long,
        rangeHeader: String?,
        fileDescriptor: java.io.FileDescriptor,
        fis: FileInputStream,
        outStream: java.io.OutputStream
    ) {
        val hasRange = !rangeHeader.isNullOrBlank() && rangeHeader.startsWith("bytes=") && totalLength > 0L
        val clampedStart: Long
        val clampedEnd: Long

        if (hasRange && rangeHeader != null) {
            val rangeSpec = rangeHeader.removePrefix("bytes=").substringBefore(",").trim()
            val parts = rangeSpec.split("-")
            val startPart = parts.getOrNull(0)?.trim() ?: ""
            val endPart = parts.getOrNull(1)?.trim() ?: ""

            if (startPart.isEmpty() && endPart.isNotEmpty()) {
                val suffixLen = endPart.toLongOrNull() ?: 0L
                clampedStart = (totalLength - suffixLen).coerceIn(0L, (totalLength - 1L).coerceAtLeast(0L))
                clampedEnd = (totalLength - 1L).coerceAtLeast(clampedStart)
            } else {
                val parsedStart = startPart.toLongOrNull() ?: 0L
                val parsedEnd = endPart.takeIf { it.isNotEmpty() }?.toLongOrNull() ?: (totalLength - 1L)
                clampedStart = parsedStart.coerceIn(0L, (totalLength - 1L).coerceAtLeast(0L))
                clampedEnd = parsedEnd.coerceIn(clampedStart, (totalLength - 1L).coerceAtLeast(clampedStart))
            }
        } else {
            clampedStart = 0L
            clampedEnd = (totalLength - 1L).coerceAtLeast(0L)
        }

        val contentLength = if (totalLength > 0L) (clampedEnd - clampedStart + 1L).coerceAtLeast(0L) else -1L

        if (clampedStart > 0L) {
            var seekOk = false
            try {
                android.system.Os.lseek(fileDescriptor, clampedStart, android.system.OsConstants.SEEK_SET)
                seekOk = true
            } catch (_: Exception) {}
            if (!seekOk) {
                try {
                    fis.channel.position(clampedStart)
                    seekOk = true
                } catch (_: Exception) {}
            }
            if (!seekOk) {
                var skipped = 0L
                val discard = ByteArray(16384)
                while (skipped < clampedStart) {
                    val s = fis.skip(clampedStart - skipped)
                    if (s > 0L) {
                        skipped += s
                    } else {
                        val toRead = minOf(discard.size.toLong(), clampedStart - skipped).toInt()
                        val r = fis.read(discard, 0, toRead)
                        if (r <= 0) break
                        skipped += r.toLong()
                    }
                }
            }
        }

        val statusLine = if (hasRange) "HTTP/1.1 206 Partial Content\r\n" else "HTTP/1.1 200 OK\r\n"
        val sb = StringBuilder(statusLine)
        sb.append("Content-Type: $mimeType\r\n")
        sb.append("Access-Control-Allow-Origin: *\r\n")
        sb.append("Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n")
        sb.append("Access-Control-Allow-Headers: Range, Content-Type, Accept, Origin\r\n")
        sb.append("Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges\r\n")
        sb.append("Accept-Ranges: bytes\r\n")
        sb.append("Cache-Control: no-store\r\n")
        if (hasRange && totalLength > 0L) {
            sb.append("Content-Range: bytes $clampedStart-$clampedEnd/$totalLength\r\n")
        }
        if (contentLength >= 0L) {
            sb.append("Content-Length: $contentLength\r\n")
        }
        sb.append("Connection: close\r\n\r\n")
        outStream.write(sb.toString().toByteArray(Charsets.UTF_8))

        if (method == "HEAD") {
            outStream.flush()
            return
        }

        val buf = ByteArray(128 * 1024)
        var remaining = if (contentLength >= 0L) contentLength else Long.MAX_VALUE
        while (remaining > 0L) {
            val toRead = minOf(buf.size.toLong(), remaining).toInt()
            val r = fis.read(buf, 0, toRead)
            if (r <= 0) break
            outStream.write(buf, 0, r)
            if (contentLength >= 0L) {
                remaining -= r.toLong()
            }
        }
        outStream.flush()
    }

    /**
     * Streams any local video from Android MediaStore (`https://maxplay.local/device-video/{id}`)
     * with exact FileChannel HTTP Range seeking and bounded stream delivery so local videos play
     * continuously from start to finish without stopping after 5-6 seconds.
     */
    fun interceptDeviceVideoRequest(
        context: Context,
        url: String,
        rangeHeader: String?
    ): WebResourceResponse? {
        return try {
            val marker = "/device-video/"
            val idx = url.indexOf(marker)
            if (idx == -1) return null

            val idStr = url.substring(idx + marker.length).substringBefore("?").substringBefore("/").trim()
            val videoId = idStr.toLongOrNull() ?: return null

            val contentUri = android.content.ContentUris.withAppendedId(
                android.provider.MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
                videoId
            )

            val rawMime = (context.contentResolver.getType(contentUri) ?: "video/mp4").lowercase()
            val mimeType = when {
                rawMime.contains("webm") -> "video/webm"
                rawMime.contains("ogg") -> "video/ogg"
                else -> "video/mp4"
            }

            val pfd = context.contentResolver.openFileDescriptor(contentUri, "r") ?: return null
            val statLen = pfd.statSize
            val totalLength = if (statLen > 0L) statLen else queryMediaStoreVideoSize(context, contentUri)
            val fis = android.os.ParcelFileDescriptor.AutoCloseInputStream(pfd)

            val baseHeaders = mutableMapOf(
                "Access-Control-Allow-Origin" to "*",
                "Access-Control-Allow-Methods" to "GET, HEAD, OPTIONS",
                "Access-Control-Allow-Headers" to "Range, Content-Type, Accept, Origin",
                "Access-Control-Expose-Headers" to "Content-Length, Content-Range, Accept-Ranges",
                "Accept-Ranges" to "bytes",
                "Cache-Control" to "no-store"
            )

            if (!rangeHeader.isNullOrBlank() && rangeHeader.startsWith("bytes=") && totalLength > 0L) {
                val rangeSpec = rangeHeader.removePrefix("bytes=").substringBefore(",").trim()
                val parts = rangeSpec.split("-")
                val startPart = parts.getOrNull(0)?.trim() ?: ""
                val endPart = parts.getOrNull(1)?.trim() ?: ""

                val clampedStart: Long
                val clampedEnd: Long

                if (startPart.isEmpty() && endPart.isNotEmpty()) {
                    // Suffix byte range: bytes=-500
                    val suffixLen = endPart.toLongOrNull() ?: 0L
                    clampedStart = (totalLength - suffixLen).coerceIn(0L, (totalLength - 1L).coerceAtLeast(0L))
                    clampedEnd = (totalLength - 1L).coerceAtLeast(clampedStart)
                } else {
                    val parsedStart = startPart.toLongOrNull() ?: 0L
                    val parsedEnd = endPart.takeIf { it.isNotEmpty() }?.toLongOrNull() ?: (totalLength - 1L)
                    clampedStart = parsedStart.coerceIn(0L, (totalLength - 1L).coerceAtLeast(0L))
                    clampedEnd = parsedEnd.coerceIn(clampedStart, (totalLength - 1L).coerceAtLeast(clampedStart))
                }

                val contentLength = (clampedEnd - clampedStart + 1L).coerceAtLeast(0L)

                var seekSucceeded = false
                try {
                    android.system.Os.lseek(pfd.fileDescriptor, clampedStart, android.system.OsConstants.SEEK_SET)
                    seekSucceeded = true
                } catch (_: Exception) {}

                if (!seekSucceeded) {
                    try {
                        fis.channel.position(clampedStart)
                        seekSucceeded = true
                    } catch (_: Exception) {}
                }

                if (!seekSucceeded && clampedStart > 0L) {
                    var skipped = 0L
                    val discardBuf = ByteArray(16384)
                    while (skipped < clampedStart) {
                        val s = fis.skip(clampedStart - skipped)
                        if (s > 0L) {
                            skipped += s
                        } else {
                            val toRead = minOf(discardBuf.size.toLong(), clampedStart - skipped).toInt()
                            val r = fis.read(discardBuf, 0, toRead)
                            if (r <= 0) break
                            skipped += r.toLong()
                        }
                    }
                }

                val boundedStream = object : java.io.InputStream() {
                    private var remaining = contentLength

                    override fun read(): Int {
                        if (remaining <= 0L) return -1
                        val b = fis.read()
                        if (b != -1) remaining--
                        return b
                    }

                    override fun read(b: ByteArray, off: Int, len: Int): Int {
                        if (remaining <= 0L) return -1
                        val toRead = minOf(len.toLong(), remaining).toInt()
                        val count = fis.read(b, off, toRead)
                        if (count > 0) {
                            remaining -= count.toLong()
                        }
                        return count
                    }

                    override fun close() {
                        try {
                            fis.close()
                        } catch (_: Exception) {}
                    }
                }

                baseHeaders["Content-Range"] = "bytes $clampedStart-$clampedEnd/$totalLength"
                baseHeaders["Content-Length"] = contentLength.toString()

                return WebResourceResponse(
                    mimeType,
                    null,
                    206,
                    "Partial Content",
                    baseHeaders,
                    boundedStream
                )
            } else {
                if (totalLength > 0L) {
                    baseHeaders["Content-Length"] = totalLength.toString()
                }
                return WebResourceResponse(
                    mimeType,
                    null,
                    200,
                    "OK",
                    baseHeaders,
                    fis
                )
            }
        } catch (_: Exception) {
            null
        }
    }

    // =========================================================================
    // DIRECT APP-TO-APP P2P TRANSFER ENGINE (MaxPlay-to-MaxPlay Direct Stream)
    // =========================================================================
    private const val VIRTUAL_LOCAL_CHUNK_SIZE = 4L * 1024L * 1024L // 4 MB virtual chunks for local phone videos

    @Volatile
    private var p2pServerSocket: java.net.ServerSocket? = null
    @Volatile
    private var p2pActiveCode: String = ""
    @Volatile
    private var p2pActiveStorageKey: String = ""
    @Volatile
    private var p2pActiveMetadataJson: String = "{}"

    private val p2pLanHttpClient: okhttp3.OkHttpClient by lazy {
        okhttp3.OkHttpClient.Builder()
            .dispatcher(okhttp3.Dispatcher().apply {
                maxRequests = 64
                maxRequestsPerHost = 32
            })
            .connectTimeout(4, java.util.concurrent.TimeUnit.SECONDS)
            .readTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
            .writeTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
            .connectionPool(okhttp3.ConnectionPool(64, 5, java.util.concurrent.TimeUnit.MINUTES))
            .retryOnConnectionFailure(true)
            .build()
    }

    private fun resolveDeviceVideoId(storageKey: String): Long? {
        val clean = storageKey.trim()
        if (clean.startsWith("dev_vid_")) {
            return clean.removePrefix("dev_vid_").trim().toLongOrNull()
        }
        return null
    }

    private fun getDeviceVideoTotalBytes(context: Context, mediaId: Long): Long {
        val contentUri = android.content.ContentUris.withAppendedId(
            android.provider.MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
            mediaId
        )
        try {
            context.contentResolver.openFileDescriptor(contentUri, "r")?.use { pfd ->
                if (pfd.statSize > 0L) return pfd.statSize
            }
        } catch (_: Exception) {}
        return queryMediaStoreVideoSize(context, contentUri)
    }

    private fun getAllLocalLanIpAddresses(context: Context): List<String> {
        val primaryIps = mutableListOf<String>()
        val secondaryIps = mutableListOf<String>()
        try {
            // Also check Android WifiManager IP if connected to Wi-Fi
            try {
                val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? android.net.wifi.WifiManager
                val ipInt = wm?.connectionInfo?.ipAddress ?: 0
                if (ipInt != 0) {
                    val wifiIp = String.format(
                        java.util.Locale.US,
                        "%d.%d.%d.%d",
                        ipInt and 0xff,
                        ipInt shr 8 and 0xff,
                        ipInt shr 16 and 0xff,
                        ipInt shr 24 and 0xff
                    )
                    if (wifiIp != "0.0.0.0" && wifiIp != "127.0.0.1") {
                        primaryIps.add(wifiIp)
                    }
                }
            } catch (_: Exception) {}

            val interfaces = java.net.NetworkInterface.getNetworkInterfaces()
            while (interfaces.hasMoreElements()) {
                val intf = interfaces.nextElement()
                if (!intf.isUp || intf.isLoopback) continue
                val name = intf.name.lowercase()
                val addrs = intf.inetAddresses
                while (addrs.hasMoreElements()) {
                    val addr = addrs.nextElement()
                    if (!addr.isLoopbackAddress && addr is java.net.Inet4Address) {
                        val ip = addr.hostAddress ?: continue
                        if (ip == "127.0.0.1" || ip.startsWith("169.254.")) continue
                        // Prioritize Hotspot / Wi-Fi / USB Tethering / Wi-Fi Direct interfaces
                        if (
                            name.contains("ap") ||
                            name.contains("wlan") ||
                            name.contains("swlan") ||
                            name.contains("softap") ||
                            name.contains("p2p") ||
                            name.contains("bridge") ||
                            name.contains("rndis")
                        ) {
                            if (!primaryIps.contains(ip)) primaryIps.add(0, ip)
                        } else if (!name.contains("rmnet") && !name.contains("ccmni") && !name.contains("dummy")) {
                            if (!secondaryIps.contains(ip)) secondaryIps.add(ip)
                        }
                    }
                }
            }
        } catch (_: Exception) {}
        val combined = (primaryIps + secondaryIps).distinct()
        return if (combined.isNotEmpty()) combined else listOf("192.168.43.1", "127.0.0.1")
    }

    private fun getLocalLanIpAddress(context: Context): String {
        return getAllLocalLanIpAddresses(context).joinToString(",")
    }

    fun stopDirectTransferServer() {
        try {
            p2pActiveCode = ""
            p2pServerSocket?.close()
            p2pServerSocket = null
        } catch (_: Exception) {}
    }

    /**
     * Starts an embedded HTTP ServerSocket on port 48821 (or dynamic fallback port) so another
     * MaxPlay app on the same Wi-Fi / Hotspot can stream segments or local phone videos directly
     * App-to-App at high speed with zero staging delay.
     */
    fun startDirectTransferServer(
        context: Context,
        storageKey: String,
        transferCode: String,
        metadataJson: String
    ): JSONObject {
        val out = JSONObject()
        try {
            stopDirectTransferServer()

            val localMediaId = resolveDeviceVideoId(storageKey)
            val safe = sanitizeKey(storageKey)
            val itemDir = File(getVaultRoot(context), safe)

            var segFiles: List<File> = emptyList()
            var audFiles: List<File> = emptyList()
            var totalBytes = 0L
            var totalSegmentsCount = 0

            if (localMediaId != null) {
                val localSize = getDeviceVideoTotalBytes(context, localMediaId)
                if (localSize <= 0L) {
                    out.put("ok", false)
                    out.put("error", "Local phone video not found in MediaStore")
                    return out
                }
                totalBytes = localSize
                totalSegmentsCount = ((localSize + VIRTUAL_LOCAL_CHUNK_SIZE - 1L) / VIRTUAL_LOCAL_CHUNK_SIZE).toInt().coerceAtLeast(1)
            } else {
                if (!itemDir.exists()) {
                    out.put("ok", false)
                    out.put("error", "Offline item directory not found on disk")
                    return out
                }

                val directMp4 = File(itemDir, "direct.mp4")
                segFiles = (itemDir.listFiles { _, name ->
                    name.startsWith("seg_") && name.endsWith(".ts")
                } ?: emptyArray()).filter { it.length() > 0L }.sortedBy {
                    it.name.removePrefix("seg_").removeSuffix(".ts").toIntOrNull() ?: 0
                }

                if (segFiles.isEmpty() && directMp4.exists() && directMp4.length() > 0L) {
                    segFiles = listOf(directMp4)
                }

                if (segFiles.isEmpty()) {
                    out.put("ok", false)
                    out.put("error", "No video segments found for this download")
                    return out
                }

                audFiles = (itemDir.listFiles { _, name ->
                    name.startsWith("aud_") && name.endsWith(".ts")
                } ?: emptyArray()).filter { it.length() > 0L }.sortedBy {
                    it.name.removePrefix("aud_").removeSuffix(".ts").toIntOrNull() ?: 0
                }

                segFiles.forEach { totalBytes += it.length() }
                audFiles.forEach { totalBytes += it.length() }
                totalSegmentsCount = segFiles.size
            }

            val server = try {
                java.net.ServerSocket(48821, 512)
            } catch (_: Exception) {
                java.net.ServerSocket(0, 512)
            }

            p2pServerSocket = server
            p2pActiveCode = transferCode.trim()
            p2pActiveStorageKey = storageKey
            p2pActiveMetadataJson = metadataJson

            val boundPort = server.localPort
            val localIp = getLocalLanIpAddress(context)

            InbuiltStreamScraper.backgroundExecutor.execute {
                while (p2pServerSocket == server && !server.isClosed) {
                    try {
                        val client = server.accept()
                        InbuiltStreamScraper.backgroundExecutor.execute {
                            handleP2pClientSocket(context, client, segFiles, audFiles, totalBytes)
                        }
                    } catch (_: Exception) {
                        break
                    }
                }
            }

            out.put("ok", true)
            out.put("ip", localIp)
            out.put("port", boundPort)
            out.put("totalSegments", totalSegmentsCount)
            out.put("totalAudioSegments", audFiles.size)
            out.put("totalBytes", totalBytes)
        } catch (e: Exception) {
            out.put("ok", false)
            out.put("error", e.message ?: "Failed to start transfer server")
        }
        return out
    }

    private fun handleP2pClientSocket(
        context: Context,
        socket: java.net.Socket,
        segFiles: List<File>,
        audFiles: List<File>,
        totalBytes: Long
    ) {
        socket.use { s ->
            try {
                s.soTimeout = 45000
                s.tcpNoDelay = true
                s.sendBufferSize = 4 * 1024 * 1024
                val reader = java.io.BufferedReader(java.io.InputStreamReader(s.getInputStream()))
                val requestLine = reader.readLine() ?: return
                val parts = requestLine.split(" ")
                if (parts.size < 2) return
                val fullUri = parts[1]
                val reqPath = fullUri.substringBefore("?")
                val queryStr = fullUri.substringAfter("?", "")

                // Drain HTTP request headers cleanly
                while (true) {
                    val hdr = reader.readLine()
                    if (hdr.isNullOrEmpty()) break
                }

                val outStream = java.io.BufferedOutputStream(s.getOutputStream(), 2 * 1024 * 1024)
                val prefix = "/maxplay-p2p/$p2pActiveCode/"
                if (!reqPath.startsWith(prefix)) {
                    val errBytes = "Not Found".toByteArray()
                    outStream.write("HTTP/1.1 404 Not Found\r\nContent-Length: ${errBytes.size}\r\n\r\n".toByteArray())
                    outStream.write(errBytes)
                    outStream.flush()
                    return
                }

                var queryStorageKey = ""
                for (pair in queryStr.split("&")) {
                    val kv = pair.split("=")
                    if (kv.size == 2 && kv[0] == "key") {
                        queryStorageKey = try {
                            java.net.URLDecoder.decode(kv[1], "UTF-8")
                        } catch (_: Exception) {
                            kv[1]
                        }
                    }
                }

                val effectiveStorageKey = if (queryStorageKey.isNotBlank()) queryStorageKey else p2pActiveStorageKey
                val localMediaId = resolveDeviceVideoId(effectiveStorageKey)
                val targetName = reqPath.removePrefix(prefix)

                // FAST ZERO-COPY PATH FOR LOCAL PHONE VIDEOS (dev_vid_<mediaId>)
                if (localMediaId != null) {
                    val localFileBytes = getDeviceVideoTotalBytes(context, localMediaId)
                    val virtualSegCount = if (localFileBytes > 0L) {
                        ((localFileBytes + VIRTUAL_LOCAL_CHUNK_SIZE - 1L) / VIRTUAL_LOCAL_CHUNK_SIZE).toInt().coerceAtLeast(1)
                    } else 0

                    if (targetName == "manifest.json") {
                        val metaObj = try { JSONObject(p2pActiveMetadataJson) } catch (_: Exception) { JSONObject() }
                        val manifestJson = JSONObject().apply {
                            put("ok", virtualSegCount > 0)
                            put("code", p2pActiveCode)
                            put("storageKey", effectiveStorageKey)
                            put("totalSegments", virtualSegCount)
                            put("totalAudioSegments", 0)
                            put("totalDurationSec", 0.0)
                            put("isSingleFile", true)
                            put("isDirectMp4", true)
                            put("totalBytes", localFileBytes)
                            put("metadata", metaObj)
                        }.toString().toByteArray(Charsets.UTF_8)

                        val headers = "HTTP/1.1 200 OK\r\n" +
                            "Content-Type: application/json\r\n" +
                            "Access-Control-Allow-Origin: *\r\n" +
                            "Content-Length: ${manifestJson.size}\r\n" +
                            "Connection: close\r\n\r\n"
                        outStream.write(headers.toByteArray(Charsets.UTF_8))
                        outStream.write(manifestJson)
                        outStream.flush()
                        return
                    }

                    val contentUri = android.content.ContentUris.withAppendedId(
                        android.provider.MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
                        localMediaId
                    )

                    if (targetName == "batch") {
                        var startIdx = 0
                        var endIdx = -1
                        for (pair in queryStr.split("&")) {
                            val kv = pair.split("=")
                            if (kv.size == 2) {
                                when (kv[0]) {
                                    "start" -> startIdx = kv[1].toIntOrNull() ?: 0
                                    "end" -> endIdx = kv[1].toIntOrNull() ?: -1
                                }
                            }
                        }

                        val clampedStart = startIdx.coerceAtLeast(0)
                        val clampedEnd = (if (endIdx >= clampedStart) endIdx else virtualSegCount - 1)
                            .coerceAtMost(virtualSegCount - 1)

                        var totalBatchPayloadBytes = 4L
                        val chunkRanges = mutableListOf<Triple<Int, Long, Int>>()
                        if (clampedStart <= clampedEnd && localFileBytes > 0L) {
                            for (idx in clampedStart..clampedEnd) {
                                val offset = idx.toLong() * VIRTUAL_LOCAL_CHUNK_SIZE
                                if (offset >= localFileBytes) break
                                val len = minOf(VIRTUAL_LOCAL_CHUNK_SIZE, localFileBytes - offset).toInt()
                                if (len > 0) {
                                    chunkRanges.add(Triple(idx, offset, len))
                                    totalBatchPayloadBytes += 8L + len.toLong()
                                }
                            }
                        }

                        val headers = "HTTP/1.1 200 OK\r\n" +
                            "Content-Type: application/octet-stream\r\n" +
                            "Access-Control-Allow-Origin: *\r\n" +
                            "Content-Length: $totalBatchPayloadBytes\r\n" +
                            "Connection: close\r\n\r\n"
                        outStream.write(headers.toByteArray(Charsets.UTF_8))

                        val dataOut = java.io.DataOutputStream(outStream)
                        val copyBuf = ByteArray(512 * 1024)
                        context.contentResolver.openFileDescriptor(contentUri, "r")?.use { pfd ->
                            val fis = FileInputStream(pfd.fileDescriptor)
                            for ((idx, offset, len) in chunkRanges) {
                                try {
                                    android.system.Os.lseek(pfd.fileDescriptor, offset, android.system.OsConstants.SEEK_SET)
                                } catch (_: Exception) {
                                    try { fis.channel.position(offset) } catch (_: Exception) {}
                                }
                                dataOut.writeInt(idx)
                                dataOut.writeInt(len)
                                var remaining = len
                                while (remaining > 0) {
                                    val toRead = minOf(copyBuf.size, remaining)
                                    val r = fis.read(copyBuf, 0, toRead)
                                    if (r <= 0) break
                                    dataOut.write(copyBuf, 0, r)
                                    remaining -= r
                                }
                            }
                        }
                        dataOut.writeInt(-1)
                        dataOut.flush()
                        return
                    }

                    if (targetName.startsWith("seg_") && targetName.endsWith(".ts")) {
                        val idx = targetName.removePrefix("seg_").removeSuffix(".ts").toIntOrNull() ?: -1
                        val offset = idx.toLong() * VIRTUAL_LOCAL_CHUNK_SIZE
                        if (idx >= 0 && offset < localFileBytes) {
                            val len = minOf(VIRTUAL_LOCAL_CHUNK_SIZE, localFileBytes - offset).toInt()
                            val headers = "HTTP/1.1 200 OK\r\n" +
                                "Content-Type: application/octet-stream\r\n" +
                                "Access-Control-Allow-Origin: *\r\n" +
                                "Content-Length: $len\r\n" +
                                "Connection: close\r\n\r\n"
                            outStream.write(headers.toByteArray(Charsets.UTF_8))
                            val copyBuf = ByteArray(512 * 1024)
                            context.contentResolver.openFileDescriptor(contentUri, "r")?.use { pfd ->
                                val fis = FileInputStream(pfd.fileDescriptor)
                                try {
                                    android.system.Os.lseek(pfd.fileDescriptor, offset, android.system.OsConstants.SEEK_SET)
                                } catch (_: Exception) {
                                    try { fis.channel.position(offset) } catch (_: Exception) {}
                                }
                                var remaining = len
                                while (remaining > 0) {
                                    val toRead = minOf(copyBuf.size, remaining)
                                    val r = fis.read(copyBuf, 0, toRead)
                                    if (r <= 0) break
                                    outStream.write(copyBuf, 0, r)
                                    remaining -= r
                                }
                            }
                            outStream.flush()
                            return
                        }
                    }

                    outStream.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".toByteArray())
                    outStream.flush()
                    return
                }

                // STANDARD VAULT PATH FOR MAXBOX & RECEIVED DOWNLOADS
                val safe = sanitizeKey(effectiveStorageKey)
                val itemDir = File(getVaultRoot(context), safe)
                val isCustomKey = effectiveStorageKey != p2pActiveStorageKey

                val activeSegFiles = if (isCustomKey) {
                    val segs = (itemDir.listFiles { _, name ->
                        name.startsWith("seg_") && name.endsWith(".ts")
                    } ?: emptyArray()).filter { it.length() > 0L }.sortedBy {
                        it.name.removePrefix("seg_").removeSuffix(".ts").toIntOrNull() ?: 0
                    }
                    val directMp4 = File(itemDir, "direct.mp4")
                    if (segs.isEmpty() && directMp4.exists() && directMp4.length() > 0L) listOf(directMp4) else segs
                } else {
                    segFiles
                }

                val activeAudFiles = if (isCustomKey) {
                    (itemDir.listFiles { _, name ->
                        name.startsWith("aud_") && name.endsWith(".ts")
                    } ?: emptyArray()).filter { it.length() > 0L }.sortedBy {
                        it.name.removePrefix("aud_").removeSuffix(".ts").toIntOrNull() ?: 0
                    }
                } else {
                    audFiles
                }

                val activeTotalBytes = if (isCustomKey) {
                    var sum = 0L
                    activeSegFiles.forEach { sum += it.length() }
                    activeAudFiles.forEach { sum += it.length() }
                    sum
                } else {
                    totalBytes
                }

                if (targetName == "manifest.json") {
                    val metaObj = try { JSONObject(p2pActiveMetadataJson) } catch (_: Exception) { JSONObject() }
                    val diskManifest = try {
                        val mf = File(itemDir, "manifest.json")
                        if (mf.exists()) JSONObject(mf.readText()) else null
                    } catch (_: Exception) {
                        null
                    }
                    val realDurationSec = diskManifest?.optDouble("totalDurationSec", 0.0)
                        ?.takeIf { it > 0.0 }
                        ?: (activeSegFiles.size * 4.0)
                    val isSingleFile = diskManifest?.optBoolean("isSingleFile", activeSegFiles.size == 1)
                        ?: (activeSegFiles.size == 1)
                    val isDirectMp4 = diskManifest?.optBoolean("isDirectMp4", false) == true ||
                        File(itemDir, "direct.mp4").exists()

                    val manifestJson = JSONObject().apply {
                        put("ok", true)
                        put("code", p2pActiveCode)
                        put("storageKey", effectiveStorageKey)
                        put("totalSegments", activeSegFiles.size)
                        put("totalAudioSegments", activeAudFiles.size)
                        put("totalDurationSec", realDurationSec)
                        put("isSingleFile", isSingleFile)
                        put("isDirectMp4", isDirectMp4)
                        put("totalBytes", activeTotalBytes)
                        put("metadata", metaObj)
                    }.toString().toByteArray(Charsets.UTF_8)

                    val headers = "HTTP/1.1 200 OK\r\n" +
                        "Content-Type: application/json\r\n" +
                        "Access-Control-Allow-Origin: *\r\n" +
                        "Content-Length: ${manifestJson.size}\r\n" +
                        "Connection: close\r\n\r\n"
                    outStream.write(headers.toByteArray(Charsets.UTF_8))
                    outStream.write(manifestJson)
                    outStream.flush()
                    return
                }

                // High-Speed Multiplexed Batch Stream Endpoint:
                // Streams segments continuously over a single TCP socket with 8-byte binary framing
                // [4-byte big-endian index][4-byte big-endian length][raw bytes] ... [-1 EOF marker]
                if (targetName == "batch") {
                    var type = "seg"
                    var startIdx = 0
                    var endIdx = -1
                    for (pair in queryStr.split("&")) {
                        val kv = pair.split("=")
                        if (kv.size == 2) {
                            when (kv[0]) {
                                "type" -> type = kv[1]
                                "start" -> startIdx = kv[1].toIntOrNull() ?: 0
                                "end" -> endIdx = kv[1].toIntOrNull() ?: -1
                            }
                        }
                    }

                    val isAud = type == "aud"
                    val fileList = if (isAud) activeAudFiles else activeSegFiles
                    val clampedStart = startIdx.coerceAtLeast(0)
                    val clampedEnd = (if (endIdx >= clampedStart) endIdx else fileList.size - 1)
                        .coerceAtMost(fileList.size - 1)

                    val resolvedBatchFiles = mutableListOf<Pair<Int, File>>()
                    var totalBatchPayloadBytes = 4L // 4 bytes for trailing -1 sentinel
                    if (clampedStart <= clampedEnd && fileList.isNotEmpty()) {
                        val prefixName = if (isAud) "aud_" else "seg_"
                        for (idx in clampedStart..clampedEnd) {
                            val exactFile = File(itemDir, "${prefixName}${idx}.ts").takeIf { it.exists() && it.length() > 0L }
                                ?: fileList.getOrNull(idx)
                            if (exactFile != null && exactFile.exists() && exactFile.length() > 0L) {
                                resolvedBatchFiles.add(idx to exactFile)
                                totalBatchPayloadBytes += 8L + exactFile.length()
                            }
                        }
                    }

                    val headers = "HTTP/1.1 200 OK\r\n" +
                        "Content-Type: application/octet-stream\r\n" +
                        "Access-Control-Allow-Origin: *\r\n" +
                        "Content-Length: $totalBatchPayloadBytes\r\n" +
                        "Connection: close\r\n\r\n"
                    outStream.write(headers.toByteArray(Charsets.UTF_8))

                    val dataOut = java.io.DataOutputStream(outStream)
                    val copyBuf = ByteArray(2 * 1024 * 1024)
                    for ((idx, exactFile) in resolvedBatchFiles) {
                        val fLen = exactFile.length().toInt()
                        dataOut.writeInt(idx)
                        dataOut.writeInt(fLen)
                        FileInputStream(exactFile).use { fis ->
                            var remaining = fLen
                            while (remaining > 0) {
                                val toRead = minOf(copyBuf.size, remaining)
                                val r = fis.read(copyBuf, 0, toRead)
                                if (r <= 0) break
                                dataOut.write(copyBuf, 0, r)
                                remaining -= r
                            }
                        }
                    }
                    // Write -1 sentinel to signal clean end of batch
                    dataOut.writeInt(-1)
                    dataOut.flush()
                    return
                }

                val targetFile = if (targetName.startsWith("seg_") && targetName.endsWith(".ts")) {
                    val idx = targetName.removePrefix("seg_").removeSuffix(".ts").toIntOrNull() ?: -1
                    File(itemDir, targetName).takeIf { it.exists() } ?: activeSegFiles.getOrNull(idx)
                } else if (targetName.startsWith("aud_") && targetName.endsWith(".ts")) {
                    val idx = targetName.removePrefix("aud_").removeSuffix(".ts").toIntOrNull() ?: -1
                    File(itemDir, targetName).takeIf { it.exists() } ?: activeAudFiles.getOrNull(idx)
                } else {
                    null
                }

                if (targetFile != null && targetFile.exists()) {
                    val headers = "HTTP/1.1 200 OK\r\n" +
                        "Content-Type: video/mp2t\r\n" +
                        "Access-Control-Allow-Origin: *\r\n" +
                        "Content-Length: ${targetFile.length()}\r\n" +
                        "Connection: close\r\n\r\n"
                    outStream.write(headers.toByteArray(Charsets.UTF_8))
                    FileInputStream(targetFile).use { fis ->
                        val buf = ByteArray(1024 * 1024)
                        var r: Int
                        while (fis.read(buf).also { r = it } != -1) {
                            outStream.write(buf, 0, r)
                        }
                    }
                    outStream.flush()
                } else {
                    outStream.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".toByteArray())
                    outStream.flush()
                }
            } catch (_: Exception) {}
        }
    }

    /**
     * Streams 100% of all video & audio segments directly from another MaxPlay device over LAN/Hotspot HTTP
     * (`http://senderIp:senderPort/maxplay-p2p/{code}/...`) into this device's native offline vault
     * (`targetStorageKey`) using parallel continuous batch-stream workers with multi-IP Hotspot discovery.
     */
    fun receiveDirectTransferFromPeer(
        context: Context,
        senderIp: String,
        senderPort: Int,
        transferCode: String,
        targetStorageKey: String,
        onProgress: (Int, String) -> Unit
    ): JSONObject {
        val out = JSONObject()
        try {
            val cleanCode = transferCode.trim()
            val candidateIps = senderIp
                .split(",", ";", " ")
                .map { it.trim() }
                .filter { it.isNotEmpty() && it != "127.0.0.1" && it != "0.0.0.0" }
                .toMutableList()

            // Always include standard Android Hotspot & Wi-Fi Direct gateway IPs as fast fallback candidates
            for (hotspotGateway in listOf("192.168.43.1", "192.168.49.1", "192.168.137.1")) {
                if (!candidateIps.contains(hotspotGateway)) {
                    candidateIps.add(hotspotGateway)
                }
            }

            onProgress(4, "Connecting to sender MaxPlay over Wi-Fi/Hotspot...")

            var winningIp: String? = null
            var manifestObj: JSONObject? = null
            val probeLatch = java.util.concurrent.CountDownLatch(1)
            val completedProbes = java.util.concurrent.atomic.AtomicInteger(0)
            val totalProbes = candidateIps.size.coerceAtLeast(1)

            val encodedTargetKey = try {
                java.net.URLEncoder.encode(targetStorageKey, "UTF-8")
            } catch (_: Exception) {
                targetStorageKey
            }

            for (candIp in candidateIps) {
                InbuiltStreamScraper.backgroundExecutor.execute {
                    try {
                        val probeUrl = "http://$candIp:$senderPort/maxplay-p2p/$cleanCode/manifest.json?key=$encodedTargetKey"
                        val req = Request.Builder().url(probeUrl).build()
                        p2pLanHttpClient.newCall(req).execute().use { resp ->
                            if (resp.isSuccessful) {
                                val str = resp.body?.string()
                                if (!str.isNullOrBlank()) {
                                    val parsed = JSONObject(str)
                                    if (parsed.optInt("totalSegments", 0) > 0) {
                                        synchronized(probeLatch) {
                                            if (winningIp == null) {
                                                winningIp = candIp
                                                manifestObj = parsed
                                                probeLatch.countDown()
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } catch (_: Exception) {
                    } finally {
                        if (completedProbes.incrementAndGet() >= totalProbes) {
                            probeLatch.countDown()
                        }
                    }
                }
            }

            probeLatch.await(5, java.util.concurrent.TimeUnit.SECONDS)

            val resolvedIp = winningIp
                ?: throw Exception("Could not reach sender on Wi-Fi/Hotspot (${candidateIps.firstOrNull() ?: senderIp}:$senderPort)")
            val validManifest = manifestObj
                ?: throw Exception("Empty manifest from sender ($resolvedIp)")

            val baseUrl = "http://$resolvedIp:$senderPort/maxplay-p2p/$cleanCode"
            onProgress(7, "Connected ($resolvedIp)! Starting high-speed transfer...")

            val totalSegs = validManifest.optInt("totalSegments", 0)
            val totalAudSegs = validManifest.optInt("totalAudioSegments", 0)
            val totalDur = validManifest.optDouble("totalDurationSec", totalSegs * 4.0)
            val isSingleFile = validManifest.optBoolean("isSingleFile", totalSegs == 1)
            val isDirectMp4 = validManifest.optBoolean("isDirectMp4", false) ||
                targetStorageKey.startsWith("dev_vid_")
            val metaObj = validManifest.optJSONObject("metadata") ?: JSONObject()
            val langLabel = metaObj.optString("language", "Default")

            if (totalSegs <= 0) {
                throw Exception("Sender has 0 segments for this item")
            }

            val itemDir = getItemDir(context, targetStorageKey)
            val receivedBytes = java.util.concurrent.atomic.AtomicLong(0L)
            val completedUnits = java.util.concurrent.atomic.AtomicInteger(0)
            val totalUnits = (totalSegs + totalAudSegs).coerceAtLeast(1)
            val startTimeMs = System.currentTimeMillis()
            val lastEmitTimeMs = java.util.concurrent.atomic.AtomicLong(0L)
            val firstError = java.util.concurrent.atomic.AtomicReference<Exception?>(null)

            fun emitProgressIfNeeded(force: Boolean = false) {
                val doneNow = completedUnits.get()
                val nowMs = System.currentTimeMillis()
                val prevEmit = lastEmitTimeMs.get()
                if (force || doneNow >= totalUnits || (nowMs - prevEmit >= 120L && lastEmitTimeMs.compareAndSet(prevEmit, nowMs))) {
                    val bytesNow = receivedBytes.get()
                    val pct = (8 + ((doneNow.toDouble() / totalUnits.toDouble()) * 89.0)).toInt().coerceIn(8, 97)
                    val mbNow = String.format(java.util.Locale.US, "%.1f", bytesNow / (1024.0 * 1024.0))
                    val elapsedSec = ((nowMs - startTimeMs) / 1000.0).coerceAtLeast(0.2)
                    val speedMb = String.format(java.util.Locale.US, "%.1f", (bytesNow / (1024.0 * 1024.0)) / elapsedSec)
                    onProgress(pct, "Turbo P2P ($mbNow MB • $speedMb MB/s)...")
                }
            }

            // Group segments into contiguous batches (smaller batches of 4 for 4MB local video chunks so all 12 workers run in parallel!)
            data class P2pBatchJob(val isAudio: Boolean, val startIdx: Int, val endIdx: Int)
            val batchJobs = java.util.concurrent.ConcurrentLinkedQueue<P2pBatchJob>()
            val batchSize = when {
                totalSegs == 1 -> 1
                isDirectMp4 -> 4
                else -> 40
            }

            var sIdx = 0
            while (sIdx < totalSegs) {
                val eIdx = minOf(totalSegs - 1, sIdx + batchSize - 1)
                batchJobs.add(P2pBatchJob(false, sIdx, eIdx))
                sIdx = eIdx + 1
            }
            var aIdx = 0
            while (aIdx < totalAudSegs) {
                val eIdx = minOf(totalAudSegs - 1, aIdx + batchSize - 1)
                batchJobs.add(P2pBatchJob(true, aIdx, eIdx))
                aIdx = eIdx + 1
            }

            val workerCount = minOf(12, batchJobs.size.coerceAtLeast(1))
            val latch = java.util.concurrent.CountDownLatch(workerCount)

            for (w in 0 until workerCount) {
                InbuiltStreamScraper.backgroundExecutor.execute {
                    val ioBuf = ByteArray(2 * 1024 * 1024)
                    try {
                        while (firstError.get() == null) {
                            val batch = batchJobs.poll() ?: break
                            val prefix = if (batch.isAudio) "aud_" else "seg_"
                            val typeParam = if (batch.isAudio) "aud" else "seg"

                            var curStart = batch.startIdx
                            while (curStart <= batch.endIdx) {
                                val existing = File(itemDir, "${prefix}${curStart}.ts")
                                if (existing.exists() && existing.length() > 512L) {
                                    receivedBytes.addAndGet(existing.length())
                                    completedUnits.incrementAndGet()
                                    curStart++
                                } else {
                                    break
                                }
                            }
                            if (curStart > batch.endIdx) {
                                emitProgressIfNeeded()
                                continue
                            }

                            var batchCompleted = false
                            for (attempt in 0 until 5) {
                                if (firstError.get() != null) break
                                while (curStart <= batch.endIdx) {
                                    val existing = File(itemDir, "${prefix}${curStart}.ts")
                                    if (existing.exists() && existing.length() > 512L) {
                                        curStart++
                                    } else {
                                        break
                                    }
                                }
                                if (curStart > batch.endIdx) {
                                    batchCompleted = true
                                    break
                                }

                                try {
                                    val batchUrl = "$baseUrl/batch?key=$encodedTargetKey&type=$typeParam&start=$curStart&end=${batch.endIdx}"
                                    val req = Request.Builder().url(batchUrl).build()
                                    p2pLanHttpClient.newCall(req).execute().use { resp ->
                                        if (!resp.isSuccessful) throw Exception("Batch HTTP ${resp.code}")
                                        val body = resp.body ?: throw Exception("Empty batch stream")
                                        val dataIn = java.io.DataInputStream(
                                            java.io.BufferedInputStream(body.byteStream(), 2 * 1024 * 1024)
                                        )
                                        while (true) {
                                            val segIndex = dataIn.readInt()
                                            if (segIndex == -1) break
                                            val segLength = dataIn.readInt()
                                            if (segLength <= 0 || segLength > 500 * 1024 * 1024) {
                                                throw Exception("Invalid segment length $segLength")
                                            }
                                            val tmpFile = File(itemDir, "${prefix}${segIndex}.tmp")
                                            val destFile = File(itemDir, "${prefix}${segIndex}.ts")
                                            FileOutputStream(tmpFile).use { fos ->
                                                var remaining = segLength
                                                while (remaining > 0) {
                                                    val toRead = minOf(ioBuf.size, remaining)
                                                    val r = dataIn.read(ioBuf, 0, toRead)
                                                    if (r == -1) {
                                                        throw java.io.EOFException("Unexpected EOF in segment $segIndex")
                                                    }
                                                    fos.write(ioBuf, 0, r)
                                                    remaining -= r
                                                }
                                                fos.flush()
                                            }
                                            if (destFile.exists()) destFile.delete()
                                            tmpFile.renameTo(destFile)
                                            receivedBytes.addAndGet(segLength.toLong())
                                            completedUnits.incrementAndGet()
                                            emitProgressIfNeeded()
                                        }
                                        batchCompleted = true
                                    }
                                    if (batchCompleted) break
                                } catch (_: Exception) {
                                    try { Thread.sleep(250L * (attempt + 1)) } catch (_: Exception) {}
                                }
                            }

                            if (!batchCompleted && firstError.get() == null) {
                                for (segIdx in curStart..batch.endIdx) {
                                    if (firstError.get() != null) break
                                    val destFile = File(itemDir, "${prefix}${segIdx}.ts")
                                    if (destFile.exists() && destFile.length() > 512L) continue

                                    val segUrl = "$baseUrl/${prefix}${segIdx}.ts?key=$encodedTargetKey"
                                    var segOk = false
                                    for (attempt in 0 until 5) {
                                        if (firstError.get() != null) break
                                        try {
                                            val req = Request.Builder().url(segUrl).build()
                                            p2pLanHttpClient.newCall(req).execute().use { resp ->
                                                if (!resp.isSuccessful) throw Exception("HTTP ${resp.code}")
                                                val body = resp.body ?: throw Exception("Empty body")
                                                val tmpFile = File(itemDir, "${prefix}${segIdx}.tmp")
                                                var segBytes = 0L
                                                FileOutputStream(tmpFile).use { fos ->
                                                    body.byteStream().use { input ->
                                                        var r: Int
                                                        while (input.read(ioBuf).also { r = it } != -1) {
                                                            fos.write(ioBuf, 0, r)
                                                            segBytes += r
                                                        }
                                                    }
                                                    fos.flush()
                                                }
                                                if (segBytes <= 0L) {
                                                    tmpFile.delete()
                                                    throw Exception("0 bytes received")
                                                }
                                                if (destFile.exists()) destFile.delete()
                                                tmpFile.renameTo(destFile)
                                                receivedBytes.addAndGet(segBytes)
                                                completedUnits.incrementAndGet()
                                                emitProgressIfNeeded()
                                                segOk = true
                                            }
                                            if (segOk) break
                                        } catch (e: Exception) {
                                            if (attempt == 4 && !batch.isAudio) {
                                                firstError.compareAndSet(
                                                    null,
                                                    Exception("Segment $segIdx transfer failed: ${e.message}")
                                                )
                                            } else {
                                                try { Thread.sleep(300L * (attempt + 1)) } catch (_: Exception) {}
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } finally {
                        latch.countDown()
                    }
                }
            }

            latch.await()
            firstError.get()?.let { throw it }

            // If a local phone video (MP4/MKV/WebM) was transferred in 4MB chunks, assemble into direct.mp4
            // so HTML5 <video> plays it natively with full byte-range seeking!
            if (isDirectMp4) {
                onProgress(98, "Finalizing local video file...")
                val directMp4Tmp = File(itemDir, "direct.mp4.tmp")
                val directMp4File = File(itemDir, "direct.mp4")
                val copyBuf = ByteArray(512 * 1024)
                FileOutputStream(directMp4Tmp).use { fos ->
                    for (idx in 0 until totalSegs) {
                        val segFile = File(itemDir, "seg_${idx}.ts")
                        if (segFile.exists() && segFile.length() > 0L) {
                            FileInputStream(segFile).use { fis ->
                                var r: Int
                                while (fis.read(copyBuf).also { r = it } != -1) {
                                    fos.write(copyBuf, 0, r)
                                }
                            }
                        }
                    }
                    fos.flush()
                }
                if (directMp4Tmp.exists() && directMp4Tmp.length() > 0L) {
                    if (directMp4File.exists()) directMp4File.delete()
                    directMp4Tmp.renameTo(directMp4File)
                    // Clean up temporary 4MB chunk files to avoid doubling disk usage
                    for (idx in 0 until totalSegs) {
                        try { File(itemDir, "seg_${idx}.ts").delete() } catch (_: Exception) {}
                    }
                }
                val metaFile = File(itemDir, "manifest.json")
                val json = JSONObject().apply {
                    put("storageKey", targetStorageKey)
                    put("totalSegments", 1)
                    put("totalAudioSegments", 0)
                    put("languageLabel", langLabel)
                    put("totalDurationSec", totalDur)
                    put("isSingleFile", true)
                    put("isDirectMp4", true)
                    put("updatedAt", System.currentTimeMillis())
                }
                metaFile.writeText(json.toString())
            } else {
                saveDownloadManifest(
                    context = context,
                    storageKey = targetStorageKey,
                    totalSegments = totalSegs,
                    totalDurationSec = totalDur,
                    isSingleFile = isSingleFile,
                    totalAudioSegments = totalAudSegs,
                    languageLabel = langLabel
                )
            }

            onProgress(100, "Transfer Complete!")
            out.put("ok", true)
            out.put("totalBytes", receivedBytes.get())
            out.put("metadata", metaObj)
        } catch (e: Exception) {
            out.put("ok", false)
            out.put("error", e.message ?: "Direct P2P transfer failed")
        }
        return out
    }

    /**
     * Exports a received local video (or single-file offline video) into Android MediaStore.Video.Media (Movies/MaxPlay)
     * so it immediately appears in the user's phone Gallery & Video apps as well as MaxPlay's Received section.
     */
    fun exportOfflineVideoToGallery(context: Context, storageKey: String, title: String): JSONObject {
        val out = JSONObject()
        try {
            val safe = sanitizeKey(storageKey)
            val itemDir = File(getVaultRoot(context), safe)
            if (!itemDir.exists()) {
                out.put("ok", false)
                out.put("error", "Offline item directory not found")
                return out
            }

            val directMp4 = File(itemDir, "direct.mp4")
            val segFiles = if (directMp4.exists() && directMp4.length() > 0L) {
                listOf(directMp4)
            } else {
                (itemDir.listFiles { _, name ->
                    name.startsWith("seg_") && name.endsWith(".ts")
                } ?: emptyArray()).filter { it.length() > 0L }.sortedBy {
                    it.name.removePrefix("seg_").removeSuffix(".ts").toIntOrNull() ?: 0
                }
            }

            if (segFiles.isEmpty()) {
                out.put("ok", false)
                out.put("error", "No video segments found to export")
                return out
            }

            val cleanTitle = title.replace(Regex("[^a-zA-Z0-9 _-]"), "").trim().ifBlank { "MaxPlay_Video_${System.currentTimeMillis()}" }
            val fileName = "${cleanTitle}.mp4"
            val resolver = context.contentResolver

            val values = android.content.ContentValues().apply {
                put(android.provider.MediaStore.Video.Media.DISPLAY_NAME, fileName)
                put(android.provider.MediaStore.Video.Media.TITLE, cleanTitle)
                put(android.provider.MediaStore.Video.Media.MIME_TYPE, "video/mp4")
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                    put(android.provider.MediaStore.Video.Media.RELATIVE_PATH, "Movies/MaxPlay")
                    put(android.provider.MediaStore.Video.Media.IS_PENDING, 1)
                }
            }

            val collection = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                android.provider.MediaStore.Video.Media.getContentUri(android.provider.MediaStore.VOLUME_EXTERNAL_PRIMARY)
            } else {
                android.provider.MediaStore.Video.Media.EXTERNAL_CONTENT_URI
            }

            val insertedUri = resolver.insert(collection, values)
                ?: throw Exception("Could not create MediaStore entry")

            var totalWritten = 0L
            resolver.openOutputStream(insertedUri)?.use { os ->
                val buf = ByteArray(512 * 1024)
                for (seg in segFiles) {
                    FileInputStream(seg).use { fis ->
                        var r: Int
                        while (fis.read(buf).also { r = it } != -1) {
                            os.write(buf, 0, r)
                            totalWritten += r
                        }
                    }
                }
                os.flush()
            }

            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                val doneValues = android.content.ContentValues().apply {
                    put(android.provider.MediaStore.Video.Media.IS_PENDING, 0)
                }
                resolver.update(insertedUri, doneValues, null, null)
            }

            out.put("ok", true)
            out.put("uri", insertedUri.toString())
            out.put("bytes", totalWritten)
        } catch (e: Exception) {
            out.put("ok", false)
            out.put("error", e.message ?: "Failed to export video to Gallery")
        }
        return out
    }
}
