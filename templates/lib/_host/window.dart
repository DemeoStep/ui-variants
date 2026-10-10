// Связь с нативным окном macOS: поднять окно поверх остальных.
import 'package:flutter/services.dart';

const MethodChannel _channel = MethodChannel('ui_variants/window');

/// Поднимает окно-пикер поверх остальных окон (после запуска и hot restart).
Future<void> bringWindowToFront() async {
  try {
    await _channel.invokeMethod<void>('activate');
  } on Object {
    // Нативная часть недоступна (например, в тестах): окно просто не поднимается.
  }
}
