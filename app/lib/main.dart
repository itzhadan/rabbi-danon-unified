import 'dart:async';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';
import 'package:webview_flutter_wkwebview/webview_flutter_wkwebview.dart';

/// The site this app shows. Everything uploaded through the admin page
/// appears in the app immediately – no rebuild needed.
const String kHomeUrl = 'https://rabbiyosefdanon.rabbiyosefdanon.workers.dev/';
const String kSiteHost = 'rabbiyosefdanon.rabbiyosefdanon.workers.dev';

const Color kNavy = Color(0xFF0F1A28);
const Color kGold = Color(0xFFD6B170);
const Color kText = Color(0xFFF6F1E6);

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
    statusBarColor: kNavy,
    statusBarIconBrightness: Brightness.light,
    statusBarBrightness: Brightness.dark,
    systemNavigationBarColor: kNavy,
    systemNavigationBarIconBrightness: Brightness.light,
  ));
  runApp(const RabbiApp());
}

class RabbiApp extends StatelessWidget {
  const RabbiApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'הרב יוסף דנון',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: kNavy,
        colorScheme: const ColorScheme.dark(primary: kGold, surface: kNavy),
      ),
      builder: (context, child) =>
          Directionality(textDirection: TextDirection.rtl, child: child!),
      home: const SitePage(),
    );
  }
}

class SitePage extends StatefulWidget {
  const SitePage({super.key});

  @override
  State<SitePage> createState() => _SitePageState();
}

class _SitePageState extends State<SitePage> {
  late final WebViewController _controller;
  bool _firstLoadDone = false;
  bool _loading = true;
  bool _error = false;
  Widget? _fullscreen; // Android full-screen video view
  DateTime? _lastBack;

  @override
  void initState() {
    super.initState();
    _controller = _createController();
    _controller.loadRequest(Uri.parse(kHomeUrl));
  }

  WebViewController _createController() {
    late final PlatformWebViewControllerCreationParams params;
    if (WebViewPlatform.instance is WebKitWebViewPlatform) {
      // iPhone / iPad: play videos inside the page, not forced full screen.
      params = WebKitWebViewControllerCreationParams(
        allowsInlineMediaPlayback: true,
        mediaTypesRequiringUserAction: const <PlaybackMediaTypes>{},
      );
    } else {
      params = const PlatformWebViewControllerCreationParams();
    }

    final controller = WebViewController.fromPlatformCreationParams(params)
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(kNavy)
      ..setNavigationDelegate(
        NavigationDelegate(
          onPageStarted: (_) {
            if (mounted) setState(() => _loading = true);
          },
          onPageFinished: (_) {
            if (mounted) {
              setState(() {
                _loading = false;
                _firstLoadDone = true;
              });
            }
          },
          onWebResourceError: (WebResourceError error) {
            // Only a failure of the page itself counts – not one image/video.
            if (error.isForMainFrame ?? false) {
              if (mounted) {
                setState(() {
                  _error = true;
                  _loading = false;
                });
              }
            }
          },
          onNavigationRequest: _onNavigation,
        ),
      );

    final platform = controller.platform;
    if (platform is AndroidWebViewController) {
      platform.setMediaPlaybackRequiresUserGesture(false);
      // Let the admin page choose videos / chat exports from the phone.
      platform.setOnShowFileSelector(_pickFiles);
      // Full-screen button of the video player.
      platform.setCustomWidgetCallbacks(
        onShowCustomWidget:
            (Widget widget, OnHideCustomWidgetCallback callback) {
          SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
          if (mounted) setState(() => _fullscreen = widget);
        },
        onHideCustomWidget: () {
          SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
          if (mounted) setState(() => _fullscreen = null);
        },
      );
    }
    return controller;
  }

  /// Pages of the site stay in the app; phone, WhatsApp and outside links
  /// open in their own apps.
  FutureOr<NavigationDecision> _onNavigation(NavigationRequest request) {
    if (!request.isMainFrame) return NavigationDecision.navigate;
    final Uri? uri = Uri.tryParse(request.url);
    if (uri == null) return NavigationDecision.prevent;
    final bool web = uri.scheme == 'http' || uri.scheme == 'https';
    if (web && uri.host == kSiteHost) return NavigationDecision.navigate;
    if (uri.scheme == 'about' || uri.scheme == 'blob' || uri.scheme == 'data') {
      return NavigationDecision.navigate;
    }
    launchUrl(uri, mode: LaunchMode.externalApplication);
    return NavigationDecision.prevent;
  }

  Future<List<String>> _pickFiles(FileSelectorParams params) async {
    try {
      final FilePickerResult? result = await FilePicker.platform.pickFiles(
        allowMultiple: params.mode == FileSelectorMode.openMultiple,
        type: FileType.any,
      );
      if (result == null) return <String>[];
      return result.files
          .where((PlatformFile f) => f.path != null)
          .map((PlatformFile f) => Uri.file(f.path!).toString())
          .toList();
    } catch (_) {
      return <String>[];
    }
  }

  void _retry() {
    setState(() {
      _error = false;
      _loading = true;
    });
    _controller.loadRequest(Uri.parse(kHomeUrl));
  }

  Future<void> _handleBack() async {
    if (_fullscreen != null) {
      // Leave full-screen video first.
      await _controller.runJavaScript(
          'if(document.fullscreenElement){document.exitFullscreen();}');
      return;
    }
    if (await _controller.canGoBack()) {
      await _controller.goBack();
      return;
    }
    final DateTime now = DateTime.now();
    if (_lastBack == null ||
        now.difference(_lastBack!) > const Duration(seconds: 2)) {
      _lastBack = now;
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('לחיצה נוספת ליציאה', textAlign: TextAlign.center),
        duration: Duration(seconds: 2),
      ));
      return;
    }
    SystemNavigator.pop();
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (bool didPop, Object? result) {
        if (!didPop) _handleBack();
      },
      child: Scaffold(
        backgroundColor: kNavy,
        body: Stack(
          children: <Widget>[
            SafeArea(child: WebViewWidget(controller: _controller)),
            if (_loading && _firstLoadDone && !_error)
              const SafeArea(
                child: Align(
                  alignment: Alignment.topCenter,
                  child: LinearProgressIndicator(
                    minHeight: 3,
                    color: kGold,
                    backgroundColor: Colors.transparent,
                  ),
                ),
              ),
            if (!_firstLoadDone && !_error) const _Splash(),
            if (_error) _ErrorView(onRetry: _retry),
            if (_fullscreen != null)
              Positioned.fill(
                child: ColoredBox(color: Colors.black, child: _fullscreen!),
              ),
          ],
        ),
      ),
    );
  }
}

// מספר הגרסה מגיע מהבנייה ב-GitHub Actions (--dart-define=APP_VERSION=1.0.N)
const String kAppVersion = String.fromEnvironment('APP_VERSION', defaultValue: 'פיתוח');

class _Splash extends StatelessWidget {
  const _Splash();

  @override
  Widget build(BuildContext context) {
    return const ColoredBox(
      color: kNavy,
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text('3 דקות לכבוד שבת',
                style: TextStyle(color: kGold, fontSize: 16)),
            SizedBox(height: 8),
            Text('הרב יוסף דנון',
                style: TextStyle(
                    color: kText, fontSize: 34, fontWeight: FontWeight.w800)),
            SizedBox(height: 28),
            SizedBox(
              width: 28,
              height: 28,
              child: CircularProgressIndicator(strokeWidth: 3, color: kGold),
            ),
            SizedBox(height: 28),
            Text('גרסה $kAppVersion',
                style: TextStyle(color: Color(0xFFB9C4D2), fontSize: 13)),
          ],
        ),
      ),
    );
  }
}

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: kNavy,
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              const Icon(Icons.wifi_off_rounded, color: kGold, size: 56),
              const SizedBox(height: 16),
              const Text('אין חיבור לאינטרנט',
                  style: TextStyle(
                      color: kText, fontSize: 22, fontWeight: FontWeight.w700)),
              const SizedBox(height: 8),
              const Text('בדקו את החיבור ונסו שוב',
                  style: TextStyle(color: Color(0xFFB9C4D2), fontSize: 15)),
              const SizedBox(height: 24),
              FilledButton(
                onPressed: onRetry,
                style: FilledButton.styleFrom(
                  backgroundColor: kGold,
                  foregroundColor: const Color(0xFF1A1409),
                  padding:
                      const EdgeInsets.symmetric(horizontal: 28, vertical: 14),
                ),
                child: const Text('נסה שוב',
                    style:
                        TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
              ),
              const SizedBox(height: 24),
              const Text('גרסה $kAppVersion',
                  style: TextStyle(color: Color(0xFFB9C4D2), fontSize: 13)),
            ],
          ),
        ),
      ),
    );
  }
}
