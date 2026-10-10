// Тема предпросмотра вариантов. Claude правит этот файл при первом показе в
// проекте: подключает тему приложения, импортируя её из package:<имя>/...
// Имена ниже использует main.dart, их не переименовывать.
import 'package:flutter/material.dart';

/// Светлая тема предпросмотра. По умолчанию стандартная Material 3.
ThemeData previewTheme() => ThemeData(useMaterial3: true);

/// Тёмная тема предпросмотра.
ThemeData previewDarkTheme() =>
    ThemeData(useMaterial3: true, brightness: Brightness.dark);

/// Делегаты локализации (например, AppLocalizations.localizationsDelegates).
List<LocalizationsDelegate<dynamic>> get previewLocalizationsDelegates =>
    const <LocalizationsDelegate<dynamic>>[];

/// Поддерживаемые локали предпросмотра.
List<Locale> get previewSupportedLocales => const <Locale>[Locale('en', 'US')];

/// Обёртка вокруг каждого варианта: провайдеры состояния, зависимости проекта.
Widget wrapPreview(BuildContext context, Widget child) => child;
