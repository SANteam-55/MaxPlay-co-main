# MaxPlay R8 / ProGuard Security & Obfuscation Rules
-optimizationpasses 5
-allowaccessmodification
-repackageclasses 'o'

# Strip debug & verbose logging in release APK
-assumenosideeffects class android.util.Log {
    public static boolean isLoggable(java.lang.String, int);
    public static int v(...);
    public static int d(...);
}

# Keep WebView JavascriptInterface methods intact for window.MaxPlayNative
-keepattributes JavascriptInterface
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod

-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

-keep class com.maxplay.app.MaxPlayNativeBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.maxplay.app.MainActivity { *; }

# OkHttp3 & Okio rules
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn javax.annotation.**
-dontwarn org.conscrypt.**
-keepnames class okhttp3.internal.publicsuffix.PublicSuffixDatabase
