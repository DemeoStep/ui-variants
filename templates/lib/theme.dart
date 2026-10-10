// Theme of the variant previews. Claude edits this file on the first show in a
// project: wires in the app's theme by importing it from package:<name>/...
// main.dart uses the names below; do not rename them.
import 'package:flutter/material.dart';

/// Light preview theme. The standard Material 3 theme by default.
ThemeData previewTheme() => ThemeData(useMaterial3: true);

/// Dark preview theme.
ThemeData previewDarkTheme() =>
    ThemeData(useMaterial3: true, brightness: Brightness.dark);

/// Localization delegates (AppLocalizations.localizationsDelegates, for example).
List<LocalizationsDelegate<dynamic>> get previewLocalizationsDelegates =>
    const <LocalizationsDelegate<dynamic>>[];

/// Supported preview locales.
List<Locale> get previewSupportedLocales => const <Locale>[Locale('en', 'US')];

/// A wrapper around every variant: state providers, project dependencies.
Widget wrapPreview(BuildContext context, Widget child) => child;
