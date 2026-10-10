// Talks to the native macOS window: raises it above other windows.
import 'package:flutter/services.dart';

const MethodChannel _channel = MethodChannel('ui_variants/window');

/// Raises the picker window above other windows (after launch and hot restart).
Future<void> bringWindowToFront() async {
  try {
    await _channel.invokeMethod<void>('activate');
  } on Object {
    // The native side is unavailable (in tests, for example): the window just stays where it is.
  }
}
